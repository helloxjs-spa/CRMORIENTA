import { isValidMonth, periodLabel } from "./ranking";

/**
 * Contas do "Resultado do mês" (metas mensais de faturamento, 008). Puras e
 * sem acesso a dados: o serviço entrega realizado e metas; aqui só a
 * matemática de progresso, ritmo e navegação de mês. Dinheiro em centavos.
 */

/** Mês "AAAA-MM" deslocado `delta` meses. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "Setembro de 2026". */
export function goalMonthLabel(month: string): string {
  const label = periodLabel({ kind: "month", month });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Mês pedido na URL, se válido; senão o padrão. */
export function resolveGoalMonth(raw: string | undefined, fallback: string): string {
  return raw && isValidMonth(raw) ? raw : fallback;
}

export type GoalProgress =
  | { kind: "none" }
  | { kind: "progress"; percent: number; remainingCents: number }
  | { kind: "reached"; percent: number; aboveCents: number };

/** Progresso do realizado sobre a meta (null = sem meta definida). */
export function goalProgress(realizedCents: number, goalCents: number | null): GoalProgress {
  if (!goalCents) return { kind: "none" };
  const percent = (realizedCents / goalCents) * 100;
  if (realizedCents >= goalCents) return { kind: "reached", percent, aboveCents: realizedCents - goalCents };
  return { kind: "progress", percent, remainingCents: goalCents - realizedCents };
}

/** Largura da barra (0–100). */
export function barWidth(progress: GoalProgress): number {
  return progress.kind === "none" ? 0 : Math.min(100, Math.max(0, progress.percent));
}

export type MonthPhase = "past" | "current" | "future";

export function monthPhase(month: string, today: string): MonthPhase {
  const todayMonth = today.slice(0, 7);
  return month < todayMonth ? "past" : month > todayMonth ? "future" : "current";
}

export type Pace = {
  /** Realizado ÷ dias decorridos (inclusive hoje) × dias do mês. */
  projectionCents: number;
  /** Dias que faltam, contando hoje (dias corridos). */
  remainingDays: number;
  /** Quanto falta por dia para bater a meta; null sem meta ou com meta batida. */
  neededPerDayCents: number | null;
};

/** Ritmo do mês em andamento (`today` = "AAAA-MM-DD" no fuso do negócio, dentro do mês). */
export function monthPace(today: string, realizedCents: number, goalCents: number | null): Pace {
  const [y, m, d] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const remainingDays = daysInMonth - d + 1;
  const projectionCents = Math.round((realizedCents / d) * daysInMonth);
  const missing = goalCents ? goalCents - realizedCents : 0;
  return {
    projectionCents,
    remainingDays,
    neededPerDayCents: goalCents && missing > 0 ? Math.ceil(missing / remainingDays) : null,
  };
}
