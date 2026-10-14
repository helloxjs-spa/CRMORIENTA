import type { Actor } from "@/server/authz/actor";
import { hasPermission } from "@/server/authz/permissions";
import type { SaleStatus } from "@/server/db/schema";

/**
 * O que a INTERFACE oferece para uma venda. Espelha as regras do serviço só
 * para não mostrar botões e campos inúteis: a segurança continua no backend
 * (cada action revalida permissão, escopo, versão e estado da venda).
 */
export type SaleActionKey = "edit" | "reverse" | "reactivate";

export function saleActionsFor(sale: { status: SaleStatus }, actor: Pick<Actor, "role">): SaleActionKey[] {
  const actions: SaleActionKey[] = [];
  const editable = sale.status === "ACTIVE" || hasPermission(actor, "sales:editReversed");
  if (editable && hasPermission(actor, "sales:edit")) actions.push("edit");
  if (sale.status === "ACTIVE" && hasPermission(actor, "sales:reverse")) actions.push("reverse");
  if (sale.status === "REVERSED" && hasPermission(actor, "sales:reactivate")) actions.push("reactivate");
  return actions;
}

/** Campos do formulário de edição, por perfil (SELLER: só incluir cursos). */
export type SaleEditCapabilities = {
  /** Remover itens, corrigir preços, forma de pagamento e parcelas. */
  financial: boolean;
  changeSeller: boolean;
  setDate: boolean;
};

export function saleEditCapabilities(actor: Pick<Actor, "role">): SaleEditCapabilities {
  return {
    financial: hasPermission(actor, "sales:editFinancial"),
    changeSeller: hasPermission(actor, "sales:changeSeller"),
    setDate: hasPermission(actor, "sales:setDate"),
  };
}
