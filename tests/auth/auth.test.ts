import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeOwnPassword, login } from "@/server/auth/auth.service";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { getActorBySessionToken } from "@/server/auth/session";
import { auditEvents, sessions } from "@/server/db/schema";
import type { DatabaseHandle } from "@/server/db/connect";
import { setUserActive } from "@/server/modules/users/users.service";
import { createTestDatabase, seedOrganization, TEST_PASSWORD } from "../support/db";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
});
afterAll(() => handle.close());

describe("hash de senha", () => {
  it("verifica a senha correta e rejeita a incorreta", async () => {
    const hash = await hashPassword("minha-senha-forte");
    expect(hash).not.toContain("minha-senha-forte");
    expect(await verifyPassword("minha-senha-forte", hash)).toBe(true);
    expect(await verifyPassword("outra-senha", hash)).toBe(false);
  });
});

describe("login e sessão", () => {
  it("login válido cria sessão que resolve o ator correto", async () => {
    const { token } = await login(handle.db, { email: "vendedor.a1@teste.local", password: TEST_PASSWORD });
    const actor = await getActorBySessionToken(handle.db, token);
    expect(actor).toMatchObject({ userId: org.ids.sellerA1, role: "SELLER", teamId: org.ids.teamA, supervisedTeamId: null });
  });

  it("supervisor recebe a equipe que lidera no ator", async () => {
    const { token } = await login(handle.db, { email: "supervisor.a@teste.local", password: TEST_PASSWORD });
    const actor = await getActorBySessionToken(handle.db, token);
    expect(actor).toMatchObject({ role: "SUPERVISOR", supervisedTeamId: org.ids.teamA, teamId: null });
  });

  it("e-mail é normalizado (maiúsculas/espaços)", async () => {
    await expect(login(handle.db, { email: "  VENDEDOR.A2@Teste.Local ", password: TEST_PASSWORD })).resolves.toHaveProperty("token");
  });

  it("senha errada e e-mail inexistente retornam a mesma mensagem genérica", async () => {
    await expect(login(handle.db, { email: "vendedor.a1@teste.local", password: "errada" })).rejects.toThrow("E-mail ou senha inválidos.");
    await expect(login(handle.db, { email: "naoexiste@teste.local", password: "x" })).rejects.toThrow("E-mail ou senha inválidos.");
  });

  it("token inválido não resolve ator", async () => {
    expect(await getActorBySessionToken(handle.db, "token-forjado")).toBeNull();
  });

  it("sessão expirada não resolve ator", async () => {
    const { token } = await login(handle.db, { email: "vendedor.b1@teste.local", password: TEST_PASSWORD });
    await handle.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, org.ids.sellerB1));
    expect(await getActorBySessionToken(handle.db, token)).toBeNull();
  });

  it("o banco guarda apenas o hash do token", async () => {
    const { token } = await login(handle.db, { email: "admin@teste.local", password: TEST_PASSWORD });
    const stored = await handle.db.select({ id: sessions.id }).from(sessions);
    expect(stored.some((s) => s.id === token)).toBe(false);
  });

  it("desativar o usuário revoga suas sessões e impede novo login", async () => {
    const { token } = await login(handle.db, { email: "vendedor.a2@teste.local", password: TEST_PASSWORD });
    await setUserActive(await org.ctx(org.ids.admin), org.ids.sellerA2, false);
    expect(await getActorBySessionToken(handle.db, token)).toBeNull();
    await expect(login(handle.db, { email: "vendedor.a2@teste.local", password: TEST_PASSWORD })).rejects.toThrow();
    await setUserActive(await org.ctx(org.ids.admin), org.ids.sellerA2, true);
  });

  it("login e falhas de login são auditados", async () => {
    const events = await handle.db.select({ action: auditEvents.action }).from(auditEvents);
    const actions = events.map((e) => e.action);
    expect(actions).toContain("auth.login");
    expect(actions).toContain("auth.login_failed");
  });

  it("troca da própria senha exige a senha atual e encerra as sessões", async () => {
    const { token } = await login(handle.db, { email: "supervisor.b@teste.local", password: TEST_PASSWORD });
    const ctx = await org.ctx(org.ids.supB);
    await expect(
      changeOwnPassword(ctx, { currentPassword: "errada", newPassword: "nova-senha-123", confirmPassword: "nova-senha-123" }),
    ).rejects.toThrow("Senha atual incorreta.");
    await changeOwnPassword(ctx, { currentPassword: TEST_PASSWORD, newPassword: "nova-senha-123", confirmPassword: "nova-senha-123" });
    expect(await getActorBySessionToken(handle.db, token)).toBeNull();
    await expect(login(handle.db, { email: "supervisor.b@teste.local", password: "nova-senha-123" })).resolves.toHaveProperty("token");
  });
});
