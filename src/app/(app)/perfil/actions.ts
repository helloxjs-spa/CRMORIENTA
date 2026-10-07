"use server";

import { headers } from "next/headers";
import type { ActionState } from "@/lib/action-state";
import { changeOwnPassword } from "@/server/auth/auth.service";
import { createSession } from "@/server/auth/session";
import { runAction, text } from "@/server/next/action";
import { setSessionCookie } from "@/server/next/session";

export async function changePasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await changeOwnPassword(ctx, {
      currentPassword: text(formData, "currentPassword"),
      newPassword: text(formData, "newPassword"),
      confirmPassword: text(formData, "confirmPassword"),
    });
    // Todas as sessões foram encerradas; mantém o usuário logado neste dispositivo.
    const h = await headers();
    const { token, expiresAt } = await createSession(ctx.db, ctx.actor.userId, { userAgent: h.get("user-agent") });
    await setSessionCookie(token, expiresAt);
    return "Senha alterada. Outras sessões abertas foram encerradas.";
  });
}
