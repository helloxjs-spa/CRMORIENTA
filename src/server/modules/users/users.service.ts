import { and, asc, eq, ilike, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { hashPassword } from "@/server/auth/password";
import { revokeAllUserSessions } from "@/server/auth/session";
import { assertPermission } from "@/server/authz/permissions";
import type { ServiceContext } from "@/server/context";
import { isUniqueViolation } from "@/server/db/errors";
import { teams, USER_ROLES, users, type UserRole } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { emailSchema, idSchema, nameSchema, parseInput, passwordSchema } from "@/server/validation";

/**
 * Colunas que podem sair do serviço. password_hash nunca é selecionado aqui.
 */
const userView = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  active: users.active,
  teamId: users.teamId,
  teamName: teams.name,
  createdAt: users.createdAt,
};

export type UserView = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  teamId: string | null;
  teamName: string | null;
  createdAt: Date;
};

const EMAIL_TAKEN = "Já existe um usuário com este e-mail.";

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

const listFiltersSchema = z.strictObject({
  role: z.enum(USER_ROLES).optional(),
  teamId: idSchema.optional(),
  active: z.boolean().optional(),
  search: z.string().trim().max(120).optional(),
});

/**
 * ADMIN: todos os usuários. SUPERVISOR: apenas os vendedores da própria equipe.
 * SELLER: sem acesso (usa getUser para o próprio perfil).
 */
export async function listUsers({ db, actor }: ServiceContext, rawFilters: unknown = {}): Promise<UserView[]> {
  assertPermission(actor, "users:view");
  const filters = parseInput(listFiltersSchema, rawFilters);

  const conditions: (SQL | undefined)[] = [];
  if (actor.role === "SUPERVISOR") {
    if (!actor.supervisedTeamId) return [];
    conditions.push(eq(users.teamId, actor.supervisedTeamId));
  }
  if (filters.role) conditions.push(eq(users.role, filters.role));
  if (filters.teamId) conditions.push(eq(users.teamId, filters.teamId));
  if (filters.active !== undefined) conditions.push(eq(users.active, filters.active));
  if (filters.search) {
    const term = `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`;
    conditions.push(or(ilike(users.name, term), ilike(users.email, term)));
  }

  return db
    .select(userView)
    .from(users)
    .leftJoin(teams, eq(teams.id, users.teamId))
    .where(and(...conditions))
    .orderBy(asc(users.name));
}

/**
 * Qualquer usuário vê o próprio perfil. Além disso: ADMIN vê todos e
 * SUPERVISOR vê os vendedores da própria equipe. Fora do escopo → NotFound.
 */
export async function getUser({ db, actor }: ServiceContext, rawId: unknown): Promise<UserView> {
  const id = parseInput(idSchema, rawId);
  const user = await findUserView(db, id);
  if (!user) throw new NotFoundError();

  const isSelf = user.id === actor.userId;
  const inScope =
    isSelf ||
    actor.role === "ADMIN" ||
    (actor.role === "SUPERVISOR" && actor.supervisedTeamId !== null && user.teamId === actor.supervisedTeamId);
  if (!inScope) throw new NotFoundError();
  return user;
}

async function findUserView(db: Database, id: string): Promise<UserView | undefined> {
  const [user] = await db.select(userView).from(users).leftJoin(teams, eq(teams.id, users.teamId)).where(eq(users.id, id)).limit(1);
  return user;
}

// ---------------------------------------------------------------------------
// Escrita (apenas ADMIN)
// ---------------------------------------------------------------------------

const createUserSchema = z
  .strictObject({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    role: z.enum(USER_ROLES, { error: "Selecione um perfil." }),
    teamId: idSchema.nullish(),
  })
  .refine((v) => v.role === "SELLER" || !v.teamId, {
    path: ["teamId"],
    message: "Somente vendedores pertencem a uma equipe.",
  });

export async function createUser({ db, actor }: ServiceContext, input: unknown): Promise<UserView> {
  assertPermission(actor, "users:manage");
  const data = parseInput(createUserSchema, input);
  const passwordHash = await hashPassword(data.password);

  try {
    const id = await db.transaction(async (tx) => {
      if (data.teamId) await assertActiveTeam(tx, data.teamId);
      const [created] = await tx
        .insert(users)
        .values({
          name: data.name,
          email: data.email,
          passwordHash,
          role: data.role,
          teamId: data.teamId ?? null,
        })
        .returning({ id: users.id });
      await recordAudit(tx, {
        actorId: actor.userId,
        action: "user.created",
        entityType: "user",
        entityId: created.id,
        teamId: data.teamId ?? null,
        metadata: { name: data.name, email: data.email, role: data.role },
      });
      return created.id;
    });
    return (await findUserView(db, id))!;
  } catch (error) {
    if (isUniqueViolation(error, "users_email_unique")) {
      throw new ConflictError(EMAIL_TAKEN);
    }
    throw error;
  }
}

const updateUserSchema = z.strictObject({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
});

export async function updateUser({ db, actor }: ServiceContext, rawId: unknown, input: unknown): Promise<UserView> {
  assertPermission(actor, "users:manage");
  const id = parseInput(idSchema, rawId);
  const data = parseInput(updateUserSchema, input);

  try {
    await db.transaction(async (tx) => {
      const before = await findUserView(tx, id);
      if (!before) throw new NotFoundError();
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (data.name !== undefined && data.name !== before.name) changes.name = { from: before.name, to: data.name };
      if (data.email !== undefined && data.email !== before.email) changes.email = { from: before.email, to: data.email };
      if (Object.keys(changes).length === 0) return;

      await tx.update(users).set({ name: data.name, email: data.email }).where(eq(users.id, id));
      await recordAudit(tx, {
        actorId: actor.userId,
        action: "user.updated",
        entityType: "user",
        entityId: id,
        teamId: before.teamId,
        metadata: { changes },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_unique")) throw new ConflictError(EMAIL_TAKEN);
    throw error;
  }
  return (await findUserView(db, id))!;
}

export async function setUserActive(
  { db, actor }: ServiceContext,
  rawId: unknown,
  rawActive: unknown,
): Promise<void> {
  assertPermission(actor, "users:manage");
  const id = parseInput(idSchema, rawId);
  const active = parseInput(z.boolean(), rawActive);
  if (id === actor.userId && !active) {
    throw new ValidationError("Você não pode desativar o próprio usuário.");
  }

  await db.transaction(async (tx) => {
    const user = await findUserView(tx, id);
    if (!user) throw new NotFoundError();
    if (user.active === active) return;

    if (!active && user.role === "SUPERVISOR") {
      const [ledTeam] = await tx.select({ name: teams.name }).from(teams).where(eq(teams.supervisorId, id)).limit(1);
      if (ledTeam) {
        throw new ConflictError(
          `Este supervisor lidera a equipe "${ledTeam.name}". Defina outro supervisor para a equipe antes de desativá-lo.`,
        );
      }
    }

    await tx.update(users).set({ active }).where(eq(users.id, id));
    if (!active) await revokeAllUserSessions(tx, id);
    await recordAudit(tx, {
      actorId: actor.userId,
      action: active ? "user.activated" : "user.deactivated",
      entityType: "user",
      entityId: id,
      teamId: user.teamId,
    });
  });
}

const resetPasswordSchema = z.strictObject({ password: passwordSchema });

export async function resetUserPassword({ db, actor }: ServiceContext, rawId: unknown, input: unknown): Promise<void> {
  assertPermission(actor, "users:manage");
  const id = parseInput(idSchema, rawId);
  const { password } = parseInput(resetPasswordSchema, input);
  const passwordHash = await hashPassword(password);

  await db.transaction(async (tx) => {
    const [updated] = await tx.update(users).set({ passwordHash }).where(eq(users.id, id)).returning({ teamId: users.teamId });
    if (!updated) throw new NotFoundError();
    await revokeAllUserSessions(tx, id);
    await recordAudit(tx, {
      actorId: actor.userId,
      action: "user.password_reset",
      entityType: "user",
      entityId: id,
      teamId: updated.teamId,
    });
  });
}

const changeTeamSchema = z.strictObject({ teamId: idSchema.nullable() });

/**
 * Move um vendedor para outra equipe (ou o deixa sem equipe). Apenas ADMIN.
 * Obs.: o efeito sobre os leads em aberto do vendedor será definido na fase de
 * Leads (ver docs/ARQUITETURA.md, Dúvidas).
 */
export async function changeSellerTeam(
  { db, actor }: ServiceContext,
  rawSellerId: unknown,
  input: unknown,
): Promise<void> {
  assertPermission(actor, "users:manage");
  const sellerId = parseInput(idSchema, rawSellerId);
  const { teamId } = parseInput(changeTeamSchema, input);

  await db.transaction(async (tx) => {
    const seller = await findUserView(tx, sellerId);
    if (!seller) throw new NotFoundError();
    if (seller.role !== "SELLER") throw new ValidationError("Apenas vendedores podem ser movidos entre equipes.");
    if (seller.teamId === teamId) return;
    if (teamId) await assertActiveTeam(tx, teamId);

    // Retrato de origem e destino no momento da mudança (equipe e supervisor),
    // para que o histórico continue legível mesmo após renomeações ou trocas
    // de supervisor.
    const [from, to] = await Promise.all([teamSnapshot(tx, seller.teamId), teamSnapshot(tx, teamId)]);

    await tx.update(users).set({ teamId }).where(eq(users.id, sellerId));
    await recordAudit(tx, {
      actorId: actor.userId,
      action: "user.team_changed",
      entityType: "user",
      entityId: sellerId,
      teamId,
      metadata: { fromTeamId: seller.teamId, toTeamId: teamId, from, to },
    });
    // Fase Leads: nesta mesma transação, os leads em aberto do vendedor passam
    // para a nova equipe, com um lead_event TEAM_CHANGED por lead.
  });
}

type TeamSnapshot = { teamId: string; teamName: string; supervisorId: string | null; supervisorName: string | null };

async function teamSnapshot(db: Database, teamId: string | null): Promise<TeamSnapshot | null> {
  if (!teamId) return null;
  const supervisor = alias(users, "supervisor");
  const [row] = await db
    .select({ teamId: teams.id, teamName: teams.name, supervisorId: teams.supervisorId, supervisorName: supervisor.name })
    .from(teams)
    .leftJoin(supervisor, eq(supervisor.id, teams.supervisorId))
    .where(eq(teams.id, teamId))
    .limit(1);
  return row ?? null;
}

async function assertActiveTeam(db: Database, teamId: string): Promise<void> {
  const [team] = await db.select({ active: teams.active }).from(teams).where(eq(teams.id, teamId)).limit(1);
  if (!team) throw new ValidationError("Equipe não encontrada.", { teamId: ["Equipe não encontrada."] });
  if (!team.active) throw new ValidationError("A equipe está inativa.", { teamId: ["A equipe está inativa."] });
}
