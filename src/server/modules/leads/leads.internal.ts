import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { leadCycles, leadEvents, leads, teams, type LeadEventType, type LeadStage, type LeadUnassignedReason } from "@/server/db/schema";
import type { Database } from "@/server/db/types";

/**
 * Peças internas do módulo de Leads, usadas pelo serviço de leads e pelo
 * serviço de usuários (desativação e troca de equipe de vendedor). Não fazem
 * checagem de permissão: quem chama já fez, e deve chamá-las DENTRO da
 * transação da mudança.
 */

export type LeadEventInput = {
  leadId: string;
  cycleId: string;
  type: LeadEventType;
  actorId: string;
  stage: LeadStage;
  fromStage?: LeadStage | null;
  ownerId: string | null;
  fromOwnerId?: string | null;
  teamId: string;
  fromTeamId?: string | null;
  supervisorId: string | null;
  fromSupervisorId?: string | null;
  unassignedReason?: LeadUnassignedReason | null;
  noteId?: string | null;
  metadata?: Record<string, unknown>;
};

/** Grava eventos na linha do tempo do lead (append-only). */
export async function recordLeadEvents(db: Database, events: LeadEventInput[]): Promise<void> {
  if (events.length === 0) return;
  await db.insert(leadEvents).values(
    events.map((e) => ({
      leadId: e.leadId,
      cycleId: e.cycleId,
      type: e.type,
      actorId: e.actorId,
      stage: e.stage,
      fromStage: e.fromStage ?? null,
      ownerId: e.ownerId,
      fromOwnerId: e.fromOwnerId ?? null,
      teamId: e.teamId,
      fromTeamId: e.fromTeamId ?? null,
      supervisorId: e.supervisorId,
      fromSupervisorId: e.fromSupervisorId ?? null,
      unassignedReason: e.unassignedReason ?? null,
      noteId: e.noteId ?? null,
      metadata: e.metadata ?? {},
    })),
  );
}

/** Supervisor atual da equipe (retrato gravado nos eventos). */
export async function supervisorOf(db: Database, teamId: string): Promise<string | null> {
  const [team] = await db.select({ supervisorId: teams.supervisorId }).from(teams).where(eq(teams.id, teamId)).limit(1);
  return team?.supervisorId ?? null;
}

/** Ciclo aberto (atual) de cada lead informado. */
async function openCyclesOf(db: Database, leadIds: string[]): Promise<Map<string, string>> {
  if (leadIds.length === 0) return new Map();
  const rows = await db
    .select({ leadId: leadCycles.leadId, id: leadCycles.id })
    .from(leadCycles)
    .where(and(inArray(leadCycles.leadId, leadIds), isNull(leadCycles.endedAt)));
  return new Map(rows.map((r) => [r.leadId, r.id]));
}

/** Leads "em operação" de um vendedor: ativos e não fechados. */
function openLeadsOf(sellerId: string) {
  return and(eq(leads.ownerId, sellerId), eq(leads.status, "ACTIVE"), ne(leads.stage, "CLOSED"));
}

export async function countOpenLeadsOfSeller(db: Database, sellerId: string): Promise<number> {
  const [row] = await db.select({ total: count() }).from(leads).where(openLeadsOf(sellerId));
  return row.total;
}

/**
 * Leads em operação de uma equipe: ativos e não fechados, com ou sem
 * responsável. Leads na Lixeira ou já fechados não contam.
 */
export async function countOpenLeadsOfTeam(db: Database, teamId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(leads)
    .where(and(eq(leads.teamId, teamId), eq(leads.status, "ACTIVE"), ne(leads.stage, "CLOSED")));
  return row.total;
}

/**
 * Desativação do vendedor: os leads em operação dele ficam SEM responsável,
 * na fila do supervisor da mesma equipe. Etapa, prazo e ciclo não mudam
 * (não é Retrabalho). Um evento UNASSIGNED por lead guarda o vendedor
 * anterior, a equipe, o supervisor, o momento e o motivo.
 */
export async function unassignOpenLeadsOfSeller(db: Database, actorId: string, sellerId: string): Promise<number> {
  const reason: LeadUnassignedReason = "OWNER_DEACTIVATED";
  const moved = await db
    .update(leads)
    .set({ ownerId: null, unassignedAt: sql`now()`, unassignedReason: reason })
    .where(openLeadsOf(sellerId))
    .returning({ id: leads.id, stage: leads.stage, teamId: leads.teamId });

  const cycles = await openCyclesOf(db, moved.map((l) => l.id));
  const supervisors = new Map<string, string | null>();
  for (const { teamId } of moved) if (!supervisors.has(teamId)) supervisors.set(teamId, await supervisorOf(db, teamId));

  await recordLeadEvents(
    db,
    moved.map((lead) => ({
      leadId: lead.id,
      cycleId: cycles.get(lead.id)!,
      type: "UNASSIGNED",
      actorId,
      stage: lead.stage,
      ownerId: null,
      fromOwnerId: sellerId,
      teamId: lead.teamId,
      supervisorId: supervisors.get(lead.teamId) ?? null,
      unassignedReason: reason,
    })),
  );
  return moved.length;
}

/**
 * Troca de equipe do vendedor (decisão C4): os leads em operação acompanham o
 * vendedor. Deve ser chamada DEPOIS de atualizar users.team_id. Um evento
 * TEAM_CHANGED por lead guarda equipe e supervisor de origem e destino.
 */
export async function moveOpenLeadsWithSeller(
  db: Database,
  actorId: string,
  sellerId: string,
  fromTeamId: string,
  toTeamId: string,
): Promise<number> {
  const moved = await db
    .update(leads)
    .set({ teamId: toTeamId })
    .where(openLeadsOf(sellerId))
    .returning({ id: leads.id, stage: leads.stage });

  const cycles = await openCyclesOf(db, moved.map((l) => l.id));
  const [fromSupervisorId, supervisorId] = await Promise.all([supervisorOf(db, fromTeamId), supervisorOf(db, toTeamId)]);

  await recordLeadEvents(
    db,
    moved.map((lead) => ({
      leadId: lead.id,
      cycleId: cycles.get(lead.id)!,
      type: "TEAM_CHANGED",
      actorId,
      stage: lead.stage,
      ownerId: sellerId,
      teamId: toTeamId,
      fromTeamId,
      supervisorId,
      fromSupervisorId,
    })),
  );
  return moved.length;
}
