import { STAGE_TRANSITIONS } from "@/lib/leads";
import type { Actor } from "@/server/authz/actor";
import { hasPermission } from "@/server/authz/permissions";
import type { LeadStage } from "@/server/db/schema";
import type { LeadView } from "@/server/modules/leads/leads.service";

/**
 * Quais ações a INTERFACE oferece para um lead. Espelha as regras dos
 * serviços só para não mostrar botões inúteis: a segurança continua no
 * backend (cada action revalida permissão, escopo e estado do lead).
 */
export type LeadActionKey = "edit" | "note" | "move" | "transfer" | "redistribute" | "trash" | "restore";

type LeadState = Pick<LeadView, "status" | "stage" | "ownerId" | "queueReason" | "stageDueAt">;

/**
 * Como a tela oferece o cadastro de lead (C41): "own" = SELLER na própria
 * carteira (precisa de equipe); "chooseSeller" = SUPERVISOR/ADMIN escolhem o
 * vendedor responsável; null = sem cadastro. O serviço revalida tudo.
 */
export function leadCreationMode(actor: Pick<Actor, "role" | "teamId">): "own" | "chooseSeller" | null {
  if (!hasPermission(actor, "leads:create")) return null;
  if (actor.role === "SELLER") return actor.teamId ? "own" : null;
  return "chooseSeller";
}

/** Situação do vendedor logado: tem negociação vencida? (bloqueia mover OUTROS leads). */
export type SellerSituation = { negotiationBlocked: boolean };

function isOverdueNegotiation(lead: LeadState, now: Date): boolean {
  return lead.status === "ACTIVE" && lead.stage === "NEGOTIATION" && lead.stageDueAt !== null && lead.stageDueAt < now;
}

/** Destinos que o vendedor pode escolher agora (vazio se não pode movimentar). */
export function moveTargetsFor(lead: LeadState, actor: Pick<Actor, "role" | "userId">, situation: SellerSituation, now = new Date()): LeadStage[] {
  if (!hasPermission(actor, "leads:move") || lead.ownerId !== actor.userId || lead.status !== "ACTIVE") return [];
  if (lead.queueReason === "FOLLOW_UP_3_EXPIRED") return [];
  if (situation.negotiationBlocked && !isOverdueNegotiation(lead, now)) return [];
  return [...STAGE_TRANSITIONS[lead.stage]];
}

export function leadActionsFor(
  lead: LeadState,
  actor: Pick<Actor, "role" | "userId">,
  situation: SellerSituation = { negotiationBlocked: false },
): LeadActionKey[] {
  const actions: LeadActionKey[] = [];
  const active = lead.status === "ACTIVE";
  const operating = active && lead.stage !== "CLOSED";
  // Follow-up 3 vencido: somente leitura para o vendedor (decisão do supervisor).
  const sellerReadOnly = actor.role === "SELLER" && lead.queueReason === "FOLLOW_UP_3_EXPIRED";

  if (active && !sellerReadOnly && hasPermission(actor, "leads:edit")) actions.push("edit");
  if (operating && !sellerReadOnly && hasPermission(actor, "leads:addNote") && lead.ownerId === actor.userId) actions.push("note");
  if (moveTargetsFor(lead, actor, situation).length > 0) actions.push("move");

  if (operating && hasPermission(actor, "leads:transfer")) {
    // Follow-up 3 vencido: o supervisor decide entre Redistribuir e Lixeira.
    // Sem responsável (vendedor desativado) ou em operação normal: Transferir e Lixeira.
    if (lead.queueReason === "FOLLOW_UP_3_EXPIRED") {
      if (hasPermission(actor, "leads:redistribute")) actions.push("redistribute");
    } else {
      actions.push("transfer");
    }
    if (hasPermission(actor, "leads:trash")) actions.push("trash");
  }
  if (lead.status === "TRASHED" && hasPermission(actor, "leads:restore")) actions.push("restore");
  return actions;
}
