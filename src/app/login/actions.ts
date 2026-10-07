"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { login } from "@/server/auth/auth.service";
import { revokeSession, SESSION_COOKIE } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { text, toErrorState } from "@/server/next/action";
import { clearSessionCookie, getCurrentActor, setSessionCookie } from "@/server/next/session";

/** Aceita apenas caminhos internos, evitando open redirect via ?next=. */
function safeNextPath(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const h = await headers();
  try {
    const { token, expiresAt } = await login(
      db,
      { email: text(formData, "email"), password: text(formData, "password") },
      {
        ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip"),
        userAgent: h.get("user-agent"),
      },
    );
    await setSessionCookie(token, expiresAt);
  } catch (error) {
    return toErrorState(error);
  }
  redirect(safeNextPath(text(formData, "next")));
}

export async function logoutAction(): Promise<void> {
  const actor = await getCurrentActor();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(db, token);
  if (actor) {
    await recordAudit(db, { actorId: actor.userId, action: "auth.logout", entityType: "session", entityId: actor.userId });
  }
  await clearSessionCookie();
  redirect("/login");
}
