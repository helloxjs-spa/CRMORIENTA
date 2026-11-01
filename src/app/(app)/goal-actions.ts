"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { parseBRLToCents } from "@/lib/money";
import { setSalesGoal } from "@/server/modules/goals/goals.service";
import { runAction, text } from "@/server/next/action";

/**
 * Meta do mês (geral ou de um vendedor). Valor em reais → centavos sem ponto
 * flutuante; texto inválido vira NaN e o serviço recusa; vazio retira a meta.
 */
export async function setSalesGoalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const amount = text(formData, "amount").trim();
    await setSalesGoal(ctx, {
      month: text(formData, "month"),
      sellerId: text(formData, "sellerId") || null,
      amountCents: amount ? (parseBRLToCents(amount) ?? Number.NaN) : null,
    });
    revalidatePath("/");
    return amount ? "Meta salva." : "Meta retirada.";
  });
}
