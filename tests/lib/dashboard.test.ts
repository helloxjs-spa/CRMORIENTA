import { describe, expect, it } from "vitest";
import { conversionRate, formatPercent, lastMonths, percentChange, shortMonthLabel } from "@/lib/dashboard";
import { parsePeriodParams, PERIOD_INVERTED } from "@/lib/ranking";

describe("conversão (cadastrados com venda válida ÷ cadastrados fora da Lixeira × 100)", () => {
  it("calcula o percentual e fica indisponível sem leads cadastrados", () => {
    expect(conversionRate(1, 4)).toBe(25);
    expect(conversionRate(0, 3)).toBe(0);
    expect(conversionRate(0, 0)).toBeNull();
    expect(formatPercent(conversionRate(0, 0))).toBe("Indisponível");
    expect(formatPercent(conversionRate(1, 3))).toBe("33,3%");
  });
});

describe("variação sobre o mês anterior", () => {
  it("percentual com base positiva; sem base comparável é indisponível", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(1, 4)).toBe(-75);
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(10, -5)).toBeNull();
    expect(formatPercent(percentChange(150, 100), { signed: true })).toBe("+50,0%");
    expect(formatPercent(percentChange(1, 4), { signed: true })).toBe("−75,0%");
    expect(formatPercent(null, { signed: true })).toBe("Indisponível");
  });
});

describe("meses", () => {
  it("lista N meses até o mês final, atravessando o ano", () => {
    expect(lastMonths("2026-02", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(lastMonths("2026-08", 13)).toHaveLength(13);
    expect(lastMonths("2026-08", 13)[0]).toBe("2025-08");
    expect(shortMonthLabel("2026-10")).toBe("out/2026");
  });

  it("período da URL do Dashboard reaproveita a regra do Ranking", () => {
    expect(parsePeriodParams({}, "2026-10")).toEqual({ period: { kind: "month", month: "2026-10" } });
    expect(parsePeriodParams({ de: "2026-10-05", ate: "2026-10-01" }, "2026-10")).toMatchObject({ periodError: PERIOD_INVERTED });
  });
});
