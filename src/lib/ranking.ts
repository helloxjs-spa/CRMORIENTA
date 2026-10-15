/**
 * Ranking (§16): regras puras usadas pelo serviço e pela tela.
 * - Critério: quantidade de vendas válidas ou valor faturado (soma dos totais).
 * - Só entra quem tem venda válida no período (C43).
 * - Empate no critério = mesma posição, e a seguinte pula (1º, 2º, 2º, 4º),
 *   sem critério de desempate (C44). A ordem alfabética entre empatados é só
 *   de exibição.
 */

export const RANKING_CRITERIA = ["count", "revenue"] as const;
export type RankingCriterion = (typeof RANKING_CRITERIA)[number];

export const RANKING_VIEWS = ["sellers", "teams"] as const;
export type RankingView = (typeof RANKING_VIEWS)[number];

export const RANKING_CRITERION_LABELS: Record<RankingCriterion, string> = {
  count: "Quantidade de vendas",
  revenue: "Valor faturado",
};

export const RANKING_VIEW_LABELS: Record<RankingView, string> = {
  sellers: "Vendedores",
  teams: "Equipes",
};

export type RankingTotals = { salesCount: number; revenueCents: number };
export type Ranked<T> = T & { position: number; tied: boolean };

const valueOf = (entry: RankingTotals, criterion: RankingCriterion) => (criterion === "count" ? entry.salesCount : entry.revenueCents);

/** Ordena pelo critério e atribui posições com empate (ranking de competição). */
export function rankEntries<T extends RankingTotals & { name: string }>(entries: T[], criterion: RankingCriterion): Ranked<T>[] {
  const sorted = [...entries].sort((a, b) => valueOf(b, criterion) - valueOf(a, criterion) || a.name.localeCompare(b.name, "pt-BR"));
  const occurrences = new Map<number, number>();
  for (const entry of sorted) occurrences.set(valueOf(entry, criterion), (occurrences.get(valueOf(entry, criterion)) ?? 0) + 1);
  let position = 0;
  return sorted.map((entry, index) => {
    if (index === 0 || valueOf(entry, criterion) !== valueOf(sorted[index - 1], criterion)) position = index + 1;
    return { ...entry, position, tied: occurrences.get(valueOf(entry, criterion))! > 1 };
  });
}

// ---------------------------------------------------------------------------
// Período (datas comerciais "AAAA-MM-DD", sem fuso)
// ---------------------------------------------------------------------------

const MONTH = /^(\d{4})-(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isValidMonth(value: string): boolean {
  const match = MONTH.exec(value);
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 12 && Number(match[1]) >= 2000;
}

/** Primeiro e último dia do mês "AAAA-MM". */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export type RankingPeriod = { kind: "month"; month: string } | { kind: "custom"; from: string; to: string };

export function periodRange(period: RankingPeriod): { from: string; to: string } {
  return period.kind === "month" ? monthRange(period.month) : { from: period.from, to: period.to };
}

const MONTH_NAMES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const br = (date: string) => date.split("-").reverse().join("/");

export function periodLabel(period: RankingPeriod): string {
  if (period.kind === "custom") return `${br(period.from)} a ${br(period.to)}`;
  const [y, m] = period.month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} de ${y}`;
}

// ---------------------------------------------------------------------------
// Parâmetros na URL: ?visao=vendedores|equipes&criterio=quantidade|faturamento
// &mes=AAAA-MM  ou  &de=AAAA-MM-DD&ate=AAAA-MM-DD (intervalo personalizado)
// ---------------------------------------------------------------------------

export type RankingParams = { view: RankingView; criterion: RankingCriterion; period: RankingPeriod; periodError?: string };

const VIEW_SLUGS: Record<string, RankingView> = { vendedores: "sellers", equipes: "teams" };
const CRITERION_SLUGS: Record<string, RankingCriterion> = { quantidade: "count", faturamento: "revenue" };
const slugOf = <T extends string>(map: Record<string, T>, value: T) => Object.keys(map).find((k) => map[k] === value)!;

export const PERIOD_INCOMPLETE = "Para um intervalo personalizado, informe as datas De e Até.";
export const PERIOD_INVERTED = "A data inicial do intervalo deve ser igual ou anterior à final.";

export type RawParams = Record<string, string | string[] | undefined>;

function first(raw: RawParams, key: string): string | undefined {
  const value = raw[key];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

/**
 * Lê os filtros da URL. Valores inválidos são ignorados; intervalo incompleto
 * ou invertido volta ao mês (`periodError` explica). Padrão: mês atual.
 */
export function parseRankingParams(raw: RawParams, currentMonth: string): RankingParams {
  const view = VIEW_SLUGS[first(raw, "visao") ?? ""] ?? "sellers";
  const criterion = CRITERION_SLUGS[first(raw, "criterio") ?? ""] ?? "count";
  return { view, criterion, ...parsePeriodParams(raw, currentMonth) };
}

/**
 * Período da URL (`mes=AAAA-MM` ou `de`/`ate`), usado pelo Ranking e pelo
 * Dashboard. Intervalo incompleto ou invertido volta ao mês, com `periodError`.
 */
export function parsePeriodParams(raw: RawParams, currentMonth: string): { period: RankingPeriod; periodError?: string } {
  const monthParam = first(raw, "mes");
  const month = monthParam && isValidMonth(monthParam) ? monthParam : currentMonth;
  const from = first(raw, "de");
  const to = first(raw, "ate");
  const validFrom = from && isValidDate(from) ? from : undefined;
  const validTo = to && isValidDate(to) ? to : undefined;

  if (!from && !to) return { period: { kind: "month", month } };
  if (!validFrom || !validTo) return { period: { kind: "month", month }, periodError: PERIOD_INCOMPLETE };
  if (validFrom > validTo) return { period: { kind: "month", month }, periodError: PERIOD_INVERTED };
  return { period: { kind: "custom", from: validFrom, to: validTo } };
}

export function rankingHref(params: Omit<RankingParams, "periodError">, overrides: Partial<Omit<RankingParams, "periodError">> = {}): string {
  const next = { ...params, ...overrides };
  const search = new URLSearchParams({ visao: slugOf(VIEW_SLUGS, next.view), criterio: slugOf(CRITERION_SLUGS, next.criterion) });
  if (next.period.kind === "month") search.set("mes", next.period.month);
  else {
    search.set("de", next.period.from);
    search.set("ate", next.period.to);
  }
  return `/ranking?${search.toString()}`;
}
