import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getActorBySessionToken, SESSION_COOKIE } from "@/server/auth/session";
import type { Actor } from "@/server/authz/actor";
import type { ServiceContext } from "@/server/context";
import { db } from "@/server/db/client";

/**
 * Data Access Layer de autenticação. Lê o cookie e valida a sessão NO BANCO a
 * cada requisição (memorizado apenas dentro da mesma requisição via cache()).
 */
export const getCurrentActor = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getActorBySessionToken(db, token);
});

export async function requireActor(): Promise<Actor> {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  return actor;
}

export async function requireServiceContext(): Promise<ServiceContext> {
  return { db, actor: await requireActor() };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
