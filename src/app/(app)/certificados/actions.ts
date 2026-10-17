"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { registerCertificate } from "@/server/modules/certificates/certificates.service";
import { runAction, text } from "@/server/next/action";

// Action fina: campos explícitos do FormData; o serviço aplica RBAC, escopo
// (404 fora dele), elegibilidade do item, validação e auditoria.
export async function registerCertificateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await registerCertificate(ctx, {
      saleItemId: text(formData, "saleItemId"),
      completedOn: text(formData, "completedOn"),
      deliveredOn: text(formData, "deliveredOn"),
      certifier: text(formData, "certifier"),
    });
    revalidatePath("/certificados");
    revalidatePath("/vendas", "layout");
    return "Certificado registrado.";
  });
}
