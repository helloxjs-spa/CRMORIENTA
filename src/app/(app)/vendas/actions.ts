"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { parseBRLToCents } from "@/lib/money";
import type { ServiceContext } from "@/server/context";
import { NotFoundError } from "@/server/errors";
import { createSale, getSale, reactivateSale, reverseSale, updateSale } from "@/server/modules/sales/sales.service";
import { runAction, text } from "@/server/next/action";

// Actions finas: leem campos explícitos do FormData e delegam ao serviço, que
// aplica RBAC, escopo (404 fora dele), validação, versão e auditoria. O total
// nunca é lido do formulário: o serviço soma os preços dos itens.

/** Vendas alteram a lista/detalhe de vendas e a etapa/linha do tempo do lead. */
function revalidateSaleViews() {
  revalidatePath("/vendas", "layout");
  revalidatePath("/leads");
  revalidatePath("/kanban");
}

function strings(formData: FormData, name: string): string[] {
  return formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));
}

/** Inteiro do formulário: campo ausente → undefined; vazio → null; texto inválido → NaN (o serviço recusa). */
function integer(formData: FormData, name: string): number | null | undefined {
  if (!formData.has(name)) return undefined;
  const value = text(formData, name).trim();
  if (!value) return null;
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

/**
 * Linhas repetíveis "id + preço" (mesma posição nos dois campos). Preço
 * digitado em reais → centavos inteiros, sem ponto flutuante; texto inválido
 * vira null e o serviço recusa.
 */
function pricedRows(formData: FormData, idField: string, priceField: string): [string, number | null][] {
  const ids = strings(formData, idField);
  const prices = strings(formData, priceField);
  return Array.from({ length: Math.max(ids.length, prices.length) }, (_, i) => [ids[i] ?? "", parseBRLToCents(prices[i] ?? "")]);
}

/** A venda está no acesso do ator? (ex.: SELLER que atribuiu a venda a um colega não a vê.) */
async function isVisible(ctx: ServiceContext, saleId: string): Promise<boolean> {
  try {
    await getSale(ctx, saleId);
    return true;
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}

export async function createSaleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const { saleId, replayed } = await createSale(ctx, {
      requestId: text(formData, "requestId"),
      leadId: text(formData, "leadId"),
      sellerId: text(formData, "sellerId") || undefined,
      saleDate: text(formData, "saleDate") || undefined,
      paymentMethod: text(formData, "paymentMethod"),
      installmentCount: integer(formData, "installmentCount"),
      items: pricedRows(formData, "itemCourseId", "itemPrice").map(([courseId, priceCents]) => ({ courseId, priceCents })),
    });
    revalidateSaleViews();
    // Fora do acesso (inclusive num reenvio): só uma confirmação genérica,
    // sem nenhum dado da venda.
    if (!(await isVisible(ctx, saleId))) {
      return {
        message: replayed
          ? "Esta solicitação já tinha sido registrada."
          : "Venda registrada para o vendedor escolhido. Ela não aparece no seu acesso.",
        redirectTo: "/vendas",
      };
    }
    return {
      message: replayed ? "Esta venda já tinha sido registrada. Nada foi gravado de novo." : "Venda registrada.",
      redirectTo: `/vendas/${saleId}`,
    };
  });
}

export async function updateSaleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    // Só os campos presentes no formulário (o formulário do vendedor não
    // tem pagamento, data, responsável, remoção nem correção de preço).
    const input: Record<string, unknown> = { expectedVersion: integer(formData, "expectedVersion") };
    if (formData.has("sellerId")) input.sellerId = text(formData, "sellerId");
    if (formData.has("saleDate")) input.saleDate = text(formData, "saleDate");
    if (formData.has("paymentMethod")) input.paymentMethod = text(formData, "paymentMethod");
    if (formData.has("installmentCount")) input.installmentCount = integer(formData, "installmentCount");
    if (formData.has("addCourseId")) {
      input.addItems = pricedRows(formData, "addCourseId", "addPrice").map(([courseId, priceCents]) => ({ courseId, priceCents }));
    }
    if (formData.has("removeItemId")) input.removeItemIds = strings(formData, "removeItemId");
    if (formData.has("repriceItemId")) {
      input.repriceItems = pricedRows(formData, "repriceItemId", "repricePrice").map(([itemId, priceCents]) => ({ itemId, priceCents }));
    }
    const result = await updateSale(ctx, text(formData, "saleId"), input);
    revalidateSaleViews();
    // SUPERVISOR pode escolher vendedor de outra equipe (C36): a venda sai do acesso dele.
    if (!(await isVisible(ctx, result.saleId))) {
      return { message: "Venda atualizada. Com o novo responsável, ela não aparece mais no seu acesso.", redirectTo: "/vendas" };
    }
    return {
      message: result.changed ? "Venda atualizada." : "Nenhuma alteração para salvar.",
      redirectTo: `/vendas/${result.saleId}`,
    };
  });
}

const REVERSAL_MESSAGES = {
  KEEP_CLOSED: "Venda estornada. O lead continua em Fechamento porque tem outra venda válida.",
  REOPEN: "Venda estornada. O lead voltou para Lead cadastrado, com o mesmo responsável, em um novo ciclo.",
  REOPEN_TO_QUEUE: "Venda estornada. O lead voltou para Lead cadastrado e aguarda o supervisor, pois o responsável está inativo.",
} as const;

export async function reverseSaleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const result = await reverseSale(ctx, text(formData, "saleId"), {
      expectedVersion: integer(formData, "expectedVersion"),
      reason: text(formData, "reason"),
    });
    revalidateSaleViews();
    return REVERSAL_MESSAGES[result.leadOutcome];
  });
}

export async function reactivateSaleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await reactivateSale(ctx, text(formData, "saleId"), {
      expectedVersion: integer(formData, "expectedVersion"),
      reason: text(formData, "reason"),
    });
    revalidateSaleViews();
    return "Venda reativada. O lead está em Fechamento com o responsável da venda.";
  });
}
