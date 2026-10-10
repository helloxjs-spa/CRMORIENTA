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
