import { describe, expect, it } from "vitest";
import {
  isValidDate,
  monthRange,
  parseRankingParams,
  PERIOD_INCOMPLETE,
  PERIOD_INVERTED,
  periodLabel,
  rankEntries,
  rankingHref,
} from "@/lib/ranking";

const entry = (name: string, salesCount: number, revenueCents: number) => ({ name, salesCount, revenueCents });

describe("posições do ranking (C44: empate divide a posição, sem desempate)", () => {
  it("ordena pelo critério e pula a posição depois do empate (1º, 2º, 2º, 4º)", () => {
    const ranked = rankEntries([entry("Dani", 1, 900), entry("Bia", 3, 100), entry("Ana", 3, 50), entry("Caio", 5, 10)], "count");
    expect(ranked.map((r) => [r.name, r.position, r.tied])).toEqual([
      ["Caio", 1, false],
      ["Ana", 2, true],
      ["Bia", 2, true],
      ["Dani", 4, false],
    ]);
  });

  it("valor faturado usa só o valor; empatados ficam em ordem alfabética apenas para exibição", () => {
    const ranked = rankEntries([entry("Zeca", 1, 500), entry("Ana", 9, 500), entry("Lia", 2, 700)], "revenue");
    expect(ranked.map((r) => [r.name, r.position, r.tied])).toEqual([
      ["Lia", 1, false],
      ["Ana", 2, true],
      ["Zeca", 2, true],
    ]);
  });

  it("lista vazia não quebra", () => {
    expect(rankEntries([], "count")).toEqual([]);
  });
});

describe("período", () => {
  it("mês: primeiro e último dia, inclusive fevereiro bissexto", () => {
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("datas inexistentes são inválidas", () => {
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-10-14")).toBe(true);
  });

  it("padrão: vendedores, quantidade e mês atual", () => {
    expect(parseRankingParams({}, "2026-10")).toEqual({ view: "sellers", criterion: "count", period: { kind: "month", month: "2026-10" } });
  });

  it("lê visão, critério, mês anterior e intervalo personalizado; ignora valores inválidos", () => {
    expect(parseRankingParams({ visao: "equipes", criterio: "faturamento", mes: "2026-07" }, "2026-10")).toEqual({
      view: "teams",
      criterion: "revenue",
      period: { kind: "month", month: "2026-07" },
    });
    expect(parseRankingParams({ de: "2026-09-10", ate: "2026-10-05", mes: "2026-07" }, "2026-10").period).toEqual({
      kind: "custom",
      from: "2026-09-10",
      to: "2026-10-05",
    });
    expect(parseRankingParams({ visao: "x", criterio: "y", mes: "2026-13" }, "2026-10")).toEqual({
      view: "sellers",
      criterion: "count",
      period: { kind: "month", month: "2026-10" },
    });
  });

  it("intervalo incompleto ou invertido volta ao mês e explica", () => {
    expect(parseRankingParams({ de: "2026-09-10" }, "2026-10")).toMatchObject({ period: { kind: "month" }, periodError: PERIOD_INCOMPLETE });
    expect(parseRankingParams({ de: "2026-10-10", ate: "2026-10-01" }, "2026-10")).toMatchObject({ periodError: PERIOD_INVERTED });
  });

  it("rótulos e URL de volta", () => {
    expect(periodLabel({ kind: "month", month: "2026-03" })).toBe("março de 2026");
    expect(periodLabel({ kind: "custom", from: "2026-09-10", to: "2026-10-05" })).toBe("10/09/2026 a 05/10/2026");
    const params = parseRankingParams({ visao: "equipes", criterio: "faturamento", de: "2026-09-10", ate: "2026-10-05" }, "2026-10");
    expect(rankingHref(params)).toBe("/ranking?visao=equipes&criterio=faturamento&de=2026-09-10&ate=2026-10-05");
    expect(rankingHref(params, { view: "sellers", period: { kind: "month", month: "2026-08" } })).toBe(
      "/ranking?visao=vendedores&criterio=faturamento&mes=2026-08",
    );
  });
});
