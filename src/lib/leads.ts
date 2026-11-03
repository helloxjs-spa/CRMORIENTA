import type { LeadStage, LeadStatus } from "@/server/db/schema";
import { BUSINESS_RULES } from "@/server/config/business-rules";

/**
 * Rótulos e estados de exibição dos leads (puros: usados em Server e Client
 * Components). Nenhuma regra de segurança mora aqui; o backend decide.
 */

/** Ordem do funil (a mesma do enum lead_stage; um teste confere). */
export const STAGE_ORDER = [
  "NEW",
  "NO_ANSWER",
  "FOLLOW_UP_1",
  "FOLLOW_UP_2",
  "FOLLOW_UP_3",
  "NEGOTIATION",
  "CLOSED",
  "REWORK",
] as const satisfies readonly LeadStage[];

export const STAGE_LABELS: Record<LeadStage, string> = {
  NEW: "Lead cadastrado",
  NO_ANSWER: "Não respondeu",
  FOLLOW_UP_1: "Follow-up 1",
  FOLLOW_UP_2: "Follow-up 2",
  FOLLOW_UP_3: "Follow-up 3",
  NEGOTIATION: "Em negociação",
  CLOSED: "Fechamento",
  REWORK: "Retrabalho",
};

/** Tamanhos de página aceitos pela listagem (o primeiro é o padrão). */
export const LEAD_PAGE_SIZES = [25, 50, 100] as const;
export type LeadPageSize = (typeof LEAD_PAGE_SIZES)[number];

export type LeadQueueReason = "UNASSIGNED" | "FOLLOW_UP_3_EXPIRED";

export const QUEUE_REASON_LABELS: Record<LeadQueueReason, string> = {
  UNASSIGNED: "Sem responsável",
  FOLLOW_UP_3_EXPIRED: "Follow-up 3 vencido",
};

/**
 * Destinos da movimentação MANUAL (decisão C32 revista em 31/10/2026: livre).
 * O serviço moveLeadStage valida contra esta tabela.
 * - Qualquer etapa vai para qualquer outra, em qualquer direção (inclusive REWORK).
 * - CLOSED nunca é destino nem origem: o banco exige Fechamento ⇔ venda válida,
 *   então o lead só entra lá pelo registro de venda.
 * - Follow-up 3 vencido continua somente leitura para o vendedor (checado no serviço).
 */
const everyStageBut = (from: LeadStage): LeadStage[] => STAGE_ORDER.filter((to) => to !== from && to !== "CLOSED");

export const STAGE_TRANSITIONS: Record<LeadStage, readonly LeadStage[]> = {
  NEW: everyStageBut("NEW"),
  NO_ANSWER: everyStageBut("NO_ANSWER"),
  FOLLOW_UP_1: everyStageBut("FOLLOW_UP_1"),
  FOLLOW_UP_2: everyStageBut("FOLLOW_UP_2"),
  FOLLOW_UP_3: everyStageBut("FOLLOW_UP_3"),
  NEGOTIATION: everyStageBut("NEGOTIATION"),
  REWORK: everyStageBut("REWORK"),
  CLOSED: [],
};

/** Etapas com prazo (24 h corridas a partir da entrada). As demais não têm prazo. */
export const STAGES_WITH_DEADLINE: readonly LeadStage[] = ["FOLLOW_UP_1", "FOLLOW_UP_2", "FOLLOW_UP_3", "NEGOTIATION"];

export function canTransition(from: LeadStage, to: LeadStage): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}

/** Curso + instituição: diferencia a mesma graduação em faculdades diferentes. */
export function courseLabel(course: { name: string; institutionName: string }): string {
  return `${course.name} — ${course.institutionName}`;
}

/** Slug da etapa na URL ("follow-up-1") e volta. */
export function stageToSlug(stage: LeadStage): string {
  return stage.toLowerCase().replace(/_/g, "-");
}

export function stageFromSlug(slug: string | undefined): LeadStage | undefined {
  return STAGE_ORDER.find((stage) => stageToSlug(stage) === slug);
}

// ---------------------------------------------------------------------------
// Prazo da etapa
// ---------------------------------------------------------------------------

type DeadlineFields = { status: LeadStatus; ownerId: string | null; stage: LeadStage; stageDueAt: Date | null };

export type DeadlineInfo =
  | { kind: "none" }
  | { kind: "unassigned" }
  | { kind: "awaiting_supervisor"; dueAt: Date }
  | { kind: "overdue"; dueAt: Date }
  | { kind: "due_today"; dueAt: Date }
  | { kind: "on_time"; dueAt: Date };

const dayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_RULES.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function sameBusinessDay(a: Date, b: Date): boolean {
  return dayKey.format(a) === dayKey.format(b);
}

/**
 * Situação do prazo calculada a partir de stage_due_at (nada é gravado quando
 * vence). Follow-up 3 vencido = aguardando decisão do supervisor.
 */
export function deadlineInfo(lead: DeadlineFields, now: Date): DeadlineInfo {
  if (lead.status !== "ACTIVE") return { kind: "none" };
  if (lead.ownerId === null) return { kind: "unassigned" };
  const dueAt = lead.stageDueAt;
  if (!dueAt) return { kind: "none" };
  if (dueAt < now) return lead.stage === "FOLLOW_UP_3" ? { kind: "awaiting_supervisor", dueAt } : { kind: "overdue", dueAt };
  return sameBusinessDay(dueAt, now) ? { kind: "due_today", dueAt } : { kind: "on_time", dueAt };
}

export type DeadlineAlert = "warning" | "expired";

/**
 * Alerta de cor do card em etapa com prazo: amarelo perto do prazo, vermelho
 * depois dele. Lead sem responsável também recebe: o prazo dele continua correndo.
 */
export function deadlineAlert(lead: DeadlineFields, now: Date): DeadlineAlert | null {
  if (lead.status !== "ACTIVE" || !lead.stageDueAt) return null;
  const remainingMs = lead.stageDueAt.getTime() - now.getTime();
  if (remainingMs < 0) return "expired";
  const deadlineHours = lead.stage === "NEGOTIATION" ? BUSINESS_RULES.negotiationDeadlineHours : BUSINESS_RULES.followUpDeadlineHours;
  return remainingMs <= (deadlineHours - BUSINESS_RULES.deadlineWarningHours) * 3_600_000 ? "warning" : null;
}
