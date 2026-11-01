import { describe, expect, it } from "vitest";
import { barWidth, goalMonthLabel, goalProgress, monthPace, monthPhase, resolveGoalMonth, shiftMonth } from "@/lib/goals";

describe("Resultado do mês — contas", () => {
  it("navegação de mês atravessa o ano", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(goalMonthLabel("2026-09")).toBe("Setembro de 2026");
    expect(resolveGoalMonth("2026-13", "2026-10")).toBe("2026-10");
    expect(resolveGoalMonth("2026-09", "2026-10")).toBe("2026-09");
  });

  it("progresso: sem meta, em andamento e batida", () => {
    expect(goalProgress(10_000, null)).toEqual({ kind: "none" });
    expect(goalProgress(3_983_560, 10_000_000)).toMatchObject({ kind: "progress", remainingCents: 6_016_440 });
    expect(goalProgress(3_983_560, 10_000_000)).toHaveProperty("percent", 39.8356);
    expect(goalProgress(12_000, 10_000)).toEqual({ kind: "reached", percent: 120, aboveCents: 2_000 });
    expect(barWidth(goalProgress(12_000, 10_000))).toBe(100);
    expect(barWidth(goalProgress(0, null))).toBe(0);
  });

  it("fase do mês", () => {
    expect(monthPhase("2026-09", "2026-10-31")).toBe("past");
    expect(monthPhase("2026-10", "2026-10-31")).toBe("current");
    expect(monthPhase("2026-11", "2026-10-31")).toBe("future");
  });

  it("ritmo: projeção pelos dias decorridos e quanto falta por dia (dias corridos, contando hoje)", () => {
    // 10 de setembro (30 dias): R$ 30.000 em 10 dias → projeção R$ 90.000; faltam R$ 70.000 em 21 dias.
    expect(monthPace("2026-09-10", 3_000_000, 10_000_000)).toEqual({ projectionCents: 9_000_000, remainingDays: 21, neededPerDayCents: 333_334 });
    // Último dia: falta tudo hoje.
    expect(monthPace("2026-10-31", 0, 50_000)).toMatchObject({ remainingDays: 1, neededPerDayCents: 50_000 });
    // Sem meta ou meta batida: sem "por dia".
    expect(monthPace("2026-10-15", 100, null).neededPerDayCents).toBeNull();
    expect(monthPace("2026-10-15", 100, 50).neededPerDayCents).toBeNull();
  });
});
