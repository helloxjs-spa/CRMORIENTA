import { and, asc, count, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { assertPermission } from "@/server/authz/permissions";
import { assertCanManageTeam, managedTeamScope } from "@/server/authz/scope";
import type { ServiceContext } from "@/server/context";
import { isUniqueViolation } from "@/server/db/errors";
import { teams, users } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { countOpenLeadsOfTeam } from "@/server/modules/leads/leads.internal";
import { idSchema, parseInput } from "@/server/validation";

const supervisor = alias(users, "supervisor");

const teamView = {
  id: teams.id,
  name: teams.name,
  active: teams.active,
  supervisorId: teams.supervisorId,
  supervisorName: supervisor.name,
  createdAt: teams.createdAt,
};

export type TeamView = {
  id: string;
  name: string;
  active: boolean;
  supervisorId: string | null;
  supervisorName: string | null;
  createdAt: Date;
};

export type TeamListItem = TeamView & { sellerCount: number };

export type TeamMember = { id: string; name: string; email: string; active: boolean };

export function teamHasOpenLeadsMessage(total: number): string {
  return total === 1
    ? "A equipe possui 1 lead ativo. Transfira ou resolva o lead antes de inativá-la."
    : `A equipe possui ${total} leads ativos. Transfira ou resolva os leads antes de inativá-la.`;
}

const NAME_TAKEN = "Já existe uma equipe com este nome.";
const SUPERVISOR_TAKEN = "Este supervisor já lidera outra equipe.";

const teamNameSchema = z
  .string()
  .trim()
  .min(2, "Informe ao menos 2 caracteres.")
  .max(80, "Use no máximo 80 caracteres.");

// ---------------------------------------------------------------------------
// Leitura — ADMIN vê todas; SUPERVISOR apenas a equipe que lidera.
// ---------------------------------------------------------------------------

export async function listTeams({ db, actor }: ServiceContext): Promise<TeamListItem[]> {
  assertPermission(actor, "teams:view");

  const sellerCounts = db
    .select({ teamId: users.teamId, total: count().as("total") })
    .from(users)
    .where(and(eq(users.role, "SELLER"), eq(users.active, true)))
    .groupBy(users.teamId)
    .as("seller_counts");

  const rows = await db
    .select({ ...teamView, sellerCount: sellerCounts.total })
    .from(teams)
    .leftJoin(supervisor, eq(supervisor.id, teams.supervisorId))
    .leftJoin(sellerCounts, eq(sellerCounts.teamId, teams.id))
    .where(managedTeamScope(actor, teams.id))
    .orderBy(asc(teams.name));

  return rows.map((r) => ({ ...r, sellerCount: Number(r.sellerCount ?? 0) }));
}

export async function getTeam(
  { db, actor }: ServiceContext,
  rawId: unknown,
): Promise<TeamView & { members: TeamMember[] }> {
  assertPermission(actor, "teams:view");
  const id = parseInput(idSchema, rawId);
  assertCanManageTeam(actor, id);

  const team = await findTeamView(db, id);
  if (!team) throw new NotFoundError();

  const members = await db
    .select({ id: users.id, name: users.name, email: users.email, active: users.active })
    .from(users)
    .where(and(eq(users.teamId, id), eq(users.role, "SELLER")))
    .orderBy(asc(users.name));

  return { ...team, members };
}

async function findTeamView(db: Database, id: string): Promise<TeamView | undefined> {
  const [team] = await db
    .select(teamView)
    .from(teams)
    .leftJoin(supervisor, eq(supervisor.id, teams.supervisorId))
    .where(eq(teams.id, id))
    .limit(1);
  return team;
}

/**
 * Equipe do próprio usuário: a que lidera (supervisor) ou a que pertence
 * (vendedor). Não inclui membros — o vendedor não vê dados de colegas.
 */
export async function getMyTeam({ db, actor }: ServiceContext): Promise<TeamView | null> {
  const id = actor.role === "SUPERVISOR" ? actor.supervisedTeamId : actor.role === "SELLER" ? actor.teamId : null;
  if (!id) return null;
  return (await findTeamView(db, id)) ?? null;
}

/** Supervisores ativos que ainda não lideram nenhuma equipe (para atribuição). */
export async function listAvailableSupervisors({ db, actor }: ServiceContext) {
  assertPermission(actor, "teams:manage");
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .leftJoin(teams, eq(teams.supervisorId, users.id))
    .where(and(eq(users.role, "SUPERVISOR"), eq(users.active, true), isNull(teams.id)))
    .orderBy(asc(users.name));
}

// ---------------------------------------------------------------------------
// Escrita — apenas ADMIN.
// ---------------------------------------------------------------------------

const createTeamSchema = z.strictObject({
  name: teamNameSchema,
  supervisorId: idSchema.nullish(),
});

export async function createTeam({ db, actor }: ServiceContext, input: unknown): Promise<TeamView> {
  assertPermission(actor, "teams:manage");
  const data = parseInput(createTeamSchema, input);

  try {
    const id = await db.transaction(async (tx) => {
      if (data.supervisorId) await assertEligibleSupervisor(tx, data.supervisorId);
      const [created] = await tx
        .insert(teams)
        .values({ name: data.name, supervisorId: data.supervisorId ?? null })
        .returning({ id: teams.id });
      await recordAudit(tx, {
        actorId: actor.userId,
        action: "team.created",
        entityType: "team",
        entityId: created.id,
        teamId: created.id,
        metadata: { name: data.name, supervisorId: data.supervisorId ?? null },
      });
      return created.id;
    });
    return (await findTeamView(db, id))!;
  } catch (error) {
    throw translateTeamConstraint(error);
  }
}

const updateTeamSchema = z.strictObject({
  name: teamNameSchema.optional(),
  active: z.boolean().optional(),
});

export async function updateTeam({ db, actor }: ServiceContext, rawId: unknown, input: unknown): Promise<TeamView> {
  assertPermission(actor, "teams:manage");
  const id = parseInput(idSchema, rawId);
  const data = parseInput(updateTeamSchema, input);

  try {
    await db.transaction(async (tx) => {
      const before = await findTeamView(tx, id);
      if (!before) throw new NotFoundError();

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (data.name !== undefined && data.name !== before.name) changes.name = { from: before.name, to: data.name };
      if (data.active !== undefined && data.active !== before.active) changes.active = { from: before.active, to: data.active };
      if (Object.keys(changes).length === 0) return;

      if (data.active === false) {
        const [{ total }] = await tx
          .select({ total: count() })
          .from(users)
          .where(and(eq(users.teamId, id), eq(users.active, true)));
        if (total > 0) {
          throw new ConflictError("A equipe possui vendedores ativos. Mova-os para outra equipe antes de inativá-la.");
        }
        // Inclui leads sem responsável (fila do supervisor). Lixeira e fechados não impedem.
        const openLeads = await countOpenLeadsOfTeam(tx, id);
        if (openLeads > 0) throw new ConflictError(teamHasOpenLeadsMessage(openLeads));
      }

      await tx.update(teams).set({ name: data.name, active: data.active }).where(eq(teams.id, id));
      await recordAudit(tx, {
        actorId: actor.userId,
        action: "team.updated",
        entityType: "team",
        entityId: id,
        teamId: id,
        metadata: { changes },
      });
    });
  } catch (error) {
    throw translateTeamConstraint(error);
  }
  return (await findTeamView(db, id))!;
}

const setSupervisorSchema = z.strictObject({ supervisorId: idSchema.nullable() });

export async function setTeamSupervisor({ db, actor }: ServiceContext, rawId: unknown, input: unknown): Promise<void> {
  assertPermission(actor, "teams:manage");
  const id = parseInput(idSchema, rawId);
  const { supervisorId } = parseInput(setSupervisorSchema, input);

  try {
    await db.transaction(async (tx) => {
      const team = await findTeamView(tx, id);
      if (!team) throw new NotFoundError();
      if (team.supervisorId === supervisorId) return;
      const toSupervisorName = supervisorId ? await assertEligibleSupervisor(tx, supervisorId) : null;

      await tx.update(teams).set({ supervisorId }).where(eq(teams.id, id));
      await recordAudit(tx, {
        actorId: actor.userId,
        action: "team.supervisor_changed",
        entityType: "team",
        entityId: id,
        teamId: id,
        metadata: {
          teamName: team.name,
          fromSupervisorId: team.supervisorId,
          fromSupervisorName: team.supervisorName,
          toSupervisorId: supervisorId,
          toSupervisorName,
        },
      });
    });
  } catch (error) {
    throw translateTeamConstraint(error);
  }
}

/** Valida o supervisor e devolve o nome dele. */
async function assertEligibleSupervisor(db: Database, userId: string): Promise<string> {
  const [user] = await db
    .select({ name: users.name, role: users.role, active: users.active, ledTeamId: teams.id })
    .from(users)
    .leftJoin(teams, eq(teams.supervisorId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  const fail = (msg: string) => new ValidationError(msg, { supervisorId: [msg] });
  if (!user || user.role !== "SUPERVISOR") throw fail("Selecione um usuário com perfil Supervisor.");
  if (!user.active) throw fail("O supervisor selecionado está inativo.");
  if (user.ledTeamId) throw fail(SUPERVISOR_TAKEN);
  return user.name;
}

/** Converte violações de unicidade (inclusive por concorrência) em mensagens de negócio. */
function translateTeamConstraint(error: unknown): unknown {
  if (isUniqueViolation(error, "teams_name_unique")) return new ConflictError(NAME_TAKEN);
  if (isUniqueViolation(error, "teams_supervisor_unique")) return new ConflictError(SUPERVISOR_TAKEN);
  return error;
}
