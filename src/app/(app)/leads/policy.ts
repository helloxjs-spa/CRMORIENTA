import type { Actor } from "@/server/authz/actor";
import { hasPermission } from "@/server/authz/permissions";
import type { LeadView } from "@/server/modules/leads/leads.service";

/**
 * Quais ações a INTERFACE oferece para um lead. Espelha as regras dos
 * serviços só para não mostrar botões inúteis: a segurança continua no
 * backend (cada action revalida permissão, escopo e estado do lead).
 */
export type LeadActionKey = "edit" | "note" | "transfer" | "redistribute" | "trash" | "restore";

type LeadState = Pick<LeadView, "status" | "stage" | "ownerId" | "queueReason">;

export function leadActionsFor(lead: LeadState, actor: Pick<Actor, "role" | "userId">): LeadActionKey[] {
  const actions: LeadActionKey[] = [];
  const active = lead.status === "ACTIVE";
  const operating = active && lead.stage !== "CLOSED";

  if (active && hasPermission(actor, "leads:edit")) actions.push("edit");
  if (operating && hasPermission(actor, "leads:addNote") && lead.ownerId === actor.userId) actions.push("note");

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
