import { describe, expect, it } from "vitest";
import { addMonths, buildInstallmentSchedule } from "@/lib/installments";

describe("cronograma de parcelas (C52)", () => {
  it("mesmo dia nos meses seguintes; dia inexistente vira o último dia do mês (sem acumular)", () => {
    expect(addMonths("2026-03-15", 1)).toBe("2026-04-15");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2026-12-10", 1)).toBe("2027-01-10");
  });

  it("valor = total ÷ quantidade; centavos que sobram na 1ª; soma = total; 1ª vence um mês após a venda", () => {
    expect(buildInstallmentSchedule("2026-03-15", 10_000, 3)).toEqual([
      { number: 1, amountCents: 3_334, dueDate: "2026-04-15" },
      { number: 2, amountCents: 3_333, dueDate: "2026-05-15" },
      { number: 3, amountCents: 3_333, dueDate: "2026-06-15" },
    ]);
    expect(buildInstallmentSchedule("2026-03-15", 150_000, 1)).toEqual([{ number: 1, amountCents: 150_000, dueDate: "2026-04-15" }]);
    const many = buildInstallmentSchedule("2026-01-31", 100_001, 12);
    expect(many.reduce((sum, p) => sum + p.amountCents, 0)).toBe(100_001);
    expect(many[0].amountCents).toBe(8_338);
    expect(many.slice(1).every((p) => p.amountCents === 8_333)).toBe(true);
    expect(many.map((p) => p.dueDate).slice(0, 3)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });
});
