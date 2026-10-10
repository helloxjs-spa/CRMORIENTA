import { describe, expect, it } from "vitest";
import { formatPhone, parseBrazilianPhone } from "@/lib/phone";

function canonical(input: string): string | null {
  const result = parseBrazilianPhone(input);
  return result.ok ? result.phone : null;
}

describe("telefone brasileiro → formato canônico", () => {
  it("formatos diferentes do mesmo celular viram o mesmo telefone", () => {
    for (const input of [
      "(79) 99999-9999",
      "79 99999-9999",
      "79999999999",
      "+55 79 99999-9999",
      "+55 (79) 99999-9999",
      "5579999999999",
      "079 99999-9999",
      " 79.99999.9999 ",
    ]) {
      expect(canonical(input), input).toBe("5579999999999");
    }
  });

  it("aceita telefone fixo (8 dígitos começando em 2 a 5)", () => {
    expect(canonical("(79) 3211-0000")).toBe("557932110000");
    expect(canonical("+55 11 2345-6789")).toBe("551123456789");
    expect(canonical("(51) 5123-4567")).toBe("555151234567");
  });

  it("DDD 55 (RS) não é confundido com o código do país", () => {
    expect(canonical("(55) 99999-9999")).toBe("5555999999999");
    expect(canonical("55 3222-1111")).toBe("555532221111");
    expect(canonical("+55 55 99999-9999")).toBe("5555999999999");
  });

  it("exige DDD", () => {
    expect(parseBrazilianPhone("99999-9999")).toEqual({ ok: false, error: "Telefone incompleto. Informe o DDD e o número." });
    expect(canonical("3211-0000")).toBeNull();
  });

  it("recusa DDD inexistente", () => {
    for (const input of ["(20) 99999-9999", "(10) 99999-9999", "(23) 3211-0000", "(90) 99999-9999", "(01) 99999-9999"]) {
      expect(canonical(input), input).toBeNull();
    }
  });

  it("exige o 9º dígito no celular", () => {
    expect(parseBrazilianPhone("(79) 9999-9999")).toEqual({
      ok: false,
      error: "Celular deve ter o 9º dígito (ex.: (79) 99999-9999).",
    });
    expect(canonical("(79) 8888-8888")).toBeNull();
    expect(canonical("(79) 89999-9999")).toBeNull();
  });

  it("recusa fixo começando em 0 ou 1, dígitos a mais e caracteres estranhos", () => {
    expect(canonical("(79) 1211-0000")).toBeNull();
    expect(canonical("(79) 999999-99999")).toBeNull();
    expect(canonical("79 9999a-9999")).toBeNull();
    expect(canonical("")).toBeNull();
  });
});

describe("formatação para a interface", () => {
  it("formata celular e fixo a partir do canônico", () => {
    expect(formatPhone("5579999999999")).toBe("(79) 99999-9999");
    expect(formatPhone("557932110000")).toBe("(79) 3211-0000");
  });
});
