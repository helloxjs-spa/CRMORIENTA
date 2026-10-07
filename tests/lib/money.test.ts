import { describe, expect, it } from "vitest";
import { centsToInput, formatBRL, parseBRLToCents } from "@/lib/money";

describe("parseBRLToCents", () => {
  it.each([
    ["300", 300_00],
    ["300,00", 300_00],
    ["R$ 300,5", 300_50],
    ["1.234,56", 1234_56],
    ["1234,56", 1234_56],
    ["1.234", 1234_00],
    ["1.234.567,89", 1234567_89],
    ["1234.56", 1234_56],
    ["0,01", 1],
    ["0", 0],
    // Precisão: valores que falham com ponto flutuante (0,1 + 0,2...).
    ["0,29", 29],
    ["1.005,07", 1005_07],
  ])("%s → %d centavos", (input, cents) => {
    expect(parseBRLToCents(input)).toBe(cents);
  });

  it.each(["", "abc", "-10", "10,999", "1,2,3", "12.3456", "1.23,45", "R$"])("rejeita %j", (input) => {
    expect(parseBRLToCents(input)).toBeNull();
  });
});

describe("formatação", () => {
  it("formata centavos em reais", () => {
    expect(formatBRL(1234_56).replace(/\s/g, " ")).toBe("R$ 1.234,56");
    expect(centsToInput(300_00)).toBe("300,00");
  });
});
