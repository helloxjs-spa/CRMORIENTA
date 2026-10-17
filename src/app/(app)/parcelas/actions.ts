"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { markInstallmentPaid } from "@/server/modules/installments/installments.service";
import { runAction, text } from "@/server/next/action";

// Action fina: só o id da parcela; o serviço aplica RBAC, escopo (404 fora
// dele), situação da parcela, travas e auditoria.
export async function markInstallmentPaidAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await markInstallmentPaid(ctx, { installmentId: text(formData, "installmentId") });
    revalidatePath("/parcelas");
    revalidatePath("/vendas", "layout");
    return "Parcela marcada como paga.";
  });
}
