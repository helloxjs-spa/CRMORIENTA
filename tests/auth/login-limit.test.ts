import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { login } from "@/server/auth/auth.service";
import { clientIpFrom, forwardedHeadersTrusted } from "@/server/auth/client-ip";
import { clearAttempts, isRateLimited, registerFailedAttempt } from "@/server/auth/rate-limit";
import type { DatabaseHandle } from "@/server/db/connect";
import { createTestDatabase, seedOrganization, TEST_PASSWORD } from "../support/db";

const LIMITED = "Muitas tentativas de login. Aguarde alguns minutos e tente novamente.";

describe("IP do cliente (testes unitários: o ambiente é simulado; não comprovam o Worker publicado)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("CF-Connecting-IP é a fonte, mesmo com X-Forwarded-For forjado pelo cliente, em qualquer ambiente", () => {
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
    expect(clientIpFrom(headers, false)).toBe("203.0.113.7");
    expect(clientIpFrom(headers, true)).toBe("203.0.113.7");
  });

  it("sem cabeçalhos confiáveis (Worker): CF-Connecting-IP ausente ou vazio → IP desconhecido, nunca X-Forwarded-For nem X-Real-IP", () => {
    const forged = { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" };
    expect(clientIpFrom(new Headers(forged), false)).toBeNull();
    expect(clientIpFrom(new Headers({ ...forged, "cf-connecting-ip": "  " }), false)).toBeNull();
  });

  it("desenvolvimento local: primeiro valor de X-Forwarded-For, depois X-Real-IP, senão null", () => {
    expect(clientIpFrom(new Headers({ "x-forwarded-for": " 10.0.0.1 , 10.0.0.2" }), true)).toBe("10.0.0.1");
    expect(clientIpFrom(new Headers({ "x-real-ip": "10.0.0.9" }), true)).toBe("10.0.0.9");
    expect(clientIpFrom(new Headers({ "cf-connecting-ip": "  ", "x-real-ip": "10.0.0.9" }), true)).toBe("10.0.0.9");
    expect(clientIpFrom(new Headers(), true)).toBeNull();
  });

  it("o fallback só é ligado com NODE_ENV development ou test (lista de permissão)", () => {
    const forged = new Headers({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" });
    vi.stubEnv("NODE_ENV", "development");
    expect(forwardedHeadersTrusted()).toBe(true);
    expect(clientIpFrom(forged)).toBe("1.2.3.4");
    vi.stubEnv("NODE_ENV", "test");
    expect(forwardedHeadersTrusted()).toBe(true);

    // Build de produção (Worker publicado, cf:preview, next start), valor inesperado ou ausente: desligado.
    for (const value of ["production", "staging", "", undefined]) {
      vi.stubEnv("NODE_ENV", value);
      expect(forwardedHeadersTrusted()).toBe(false);
      expect(clientIpFrom(forged)).toBeNull();
      expect(clientIpFrom(new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4" }))).toBe("203.0.113.9");
    }
  });
});

describe("limite de tentativas (em memória, janela fixa de 15 min, 10 falhas)", () => {
  it("bloqueia na 10ª falha, libera quando a janela vence e é zerado por clearAttempts", () => {
    const key = "janela@teste.local|203.0.113.1";
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i++) registerFailedAttempt(key, t0);
    expect(isRateLimited(key, t0)).toBe(false);
    registerFailedAttempt(key, t0);
    expect(isRateLimited(key, t0)).toBe(true);
    expect(isRateLimited(key, t0 + 15 * 60 * 1000)).toBe(false);
    registerFailedAttempt(key, t0 + 15 * 60 * 1000); // nova janela: recomeça em 1
    expect(isRateLimited(key, t0 + 15 * 60 * 1000)).toBe(false);
    for (let i = 0; i < 9; i++) registerFailedAttempt(key, t0 + 15 * 60 * 1000);
    expect(isRateLimited(key, t0 + 15 * 60 * 1000)).toBe(true);
    clearAttempts(key);
    expect(isRateLimited(key, t0 + 15 * 60 * 1000)).toBe(false);
  });
});

describe("login com o limite", () => {
  let handle: DatabaseHandle;
  beforeAll(async () => {
    handle = await createTestDatabase();
    await seedOrganization(handle);
  });
  afterAll(() => handle.close());

  it("10 senhas erradas do mesmo e-mail e IP bloqueiam até a senha certa; outro IP não é afetado (chave e-mail + IP)", async () => {
    const email = "vendedor.a1@teste.local";
    const ip = { ipAddress: "198.51.100.10" };
    for (let i = 0; i < 10; i++) {
      await expect(login(handle.db, { email, password: "errada" }, ip)).rejects.toThrow("E-mail ou senha inválidos.");
    }
    await expect(login(handle.db, { email, password: TEST_PASSWORD }, ip)).rejects.toThrow(LIMITED);
    await expect(login(handle.db, { email, password: TEST_PASSWORD }, { ipAddress: "198.51.100.11" })).resolves.toHaveProperty("token");
  });
});
