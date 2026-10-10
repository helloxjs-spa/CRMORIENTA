import { LEAD_PAGE_SIZES, stageFromSlug, stageToSlug, type LeadPageSize } from "@/lib/leads";
import type { LeadStage } from "@/server/db/schema";

/**
 * Estado da tela de Leads na URL (filtros, página, aba e lead aberto no
 * drawer), para que recarregar ou compartilhar o link mantenha a visão.
 * Valores inválidos são ignorados; o serviço aplica escopo e validação de novo.
 */

export type LeadsView = "carteira" | "fila" | "lixeira";
export type QueueFilter = "todos" | "sem-responsavel" | "follow-up-3";

export type LeadsParams = {
  view: LeadsView;
  q?: string;
  stage?: LeadStage;
  course?: string;
  seller?: string;
  team?: string;
  queue: QueueFilter;
  page: number;
  size: LeadPageSize;
  lead?: string;
};

type RawParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(raw: RawParams, key: string): string | undefined {
  const value = raw[key];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || undefined;
}

function uuid(raw: RawParams, key: string): string | undefined {
  const value = first(raw, key);
  return value && UUID.test(value) ? value : undefined;
}

export function parseLeadsParams(raw: RawParams): LeadsParams {
  const view = first(raw, "visao");
  const queue = first(raw, "motivo");
  const page = Number(first(raw, "pagina"));
  const size = Number(first(raw, "por"));
  return {
    view: view === "fila" || view === "lixeira" ? view : "carteira",
    q: first(raw, "q")?.slice(0, 120),
    stage: stageFromSlug(first(raw, "etapa")),
    course: uuid(raw, "curso"),
    seller: uuid(raw, "vendedor"),
    team: uuid(raw, "equipe"),
    queue: queue === "sem-responsavel" || queue === "follow-up-3" ? queue : "todos",
    page: Number.isInteger(page) && page > 1 ? page : 1,
    size: (LEAD_PAGE_SIZES as readonly number[]).includes(size) ? (size as LeadPageSize) : LEAD_PAGE_SIZES[0],
    lead: uuid(raw, "lead"),
  };
}

/** Monta a URL da tela, omitindo valores padrão. */
export function leadsHref(params: LeadsParams, overrides: Partial<LeadsParams> = {}): string {
  const p = { ...params, ...overrides };
  const query = new URLSearchParams();
  if (p.view !== "carteira") query.set("visao", p.view);
  if (p.view === "fila" && p.queue !== "todos") query.set("motivo", p.queue);
  if (p.q) query.set("q", p.q);
  if (p.stage) query.set("etapa", stageToSlug(p.stage));
  if (p.course) query.set("curso", p.course);
  if (p.seller) query.set("vendedor", p.seller);
  if (p.team) query.set("equipe", p.team);
  if (p.page > 1) query.set("pagina", String(p.page));
  if (p.size !== LEAD_PAGE_SIZES[0]) query.set("por", String(p.size));
  if (p.lead) query.set("lead", p.lead);
  const text = query.toString();
  return text ? `/leads?${text}` : "/leads";
}

/** Filtros que mudam o conjunto de resultados (para saber se há filtro ativo). */
export function hasResultFilters(p: LeadsParams): boolean {
  return !!(p.q || p.stage || p.course || p.seller || p.team);
}

const QUEUE_TO_SERVICE = { todos: "ALL", "sem-responsavel": "UNASSIGNED", "follow-up-3": "FOLLOW_UP_3_EXPIRED" } as const;

/**
 * Converte a URL nos filtros do serviço. Quem não opera a carteira da equipe
 * (SELLER) fica sempre na própria carteira, sem filtro de vendedor/equipe.
 */
export function toListFilters(p: LeadsParams, { canManage, canFilterTeam }: { canManage: boolean; canFilterTeam: boolean }) {
  const view: LeadsView = canManage ? p.view : "carteira";
  return {
    page: p.page,
    pageSize: p.size,
    search: p.q,
    stage: view === "lixeira" ? undefined : p.stage,
    courseId: p.course,
    ownerId: canManage ? p.seller : undefined,
    teamId: canFilterTeam ? p.team : undefined,
    status: view === "lixeira" ? ("TRASHED" as const) : ("ACTIVE" as const),
    queue: view === "fila" ? QUEUE_TO_SERVICE[p.queue] : undefined,
  };
}
