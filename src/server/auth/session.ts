import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { sessions, teams, users } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import type { Actor } from "@/server/authz/actor";

export { SESSION_COOKIE } from "./constants";
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS ?? 12) * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  db: Database,
  userId: string,
  meta: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    expiresAt,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
  });
  // Limpeza oportunista de sessões expiradas do próprio usuário.
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date())));
  return { token, expiresAt };
}

/** Retorna o Actor da sessão, ou null se o token for inválido, expirado ou o usuário estiver inativo. */
export async function getActorBySessionToken(db: Database, token: string): Promise<Actor | null> {
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date()), eq(users.active, true)))
    .limit(1);
  return row ? loadActor(db, row.userId) : null;
}

export async function loadActor(db: Database, userId: string): Promise<Actor | null> {
  const [row] = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      teamId: users.teamId,
      active: users.active,
      supervisedTeamId: teams.id,
    })
    .from(users)
    .leftJoin(teams, eq(teams.supervisorId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || !row.active) return null;
  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: row.role,
    teamId: row.role === "SELLER" ? row.teamId : null,
    supervisedTeamId: row.role === "SUPERVISOR" ? row.supervisedTeamId : null,
  };
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

export async function revokeAllUserSessions(db: Database, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
