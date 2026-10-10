import { and, asc, desc, eq, ilike, isNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { parseBrazilianPhone, phoneSearchDigits } from "@/lib/phone";
import type { Actor } from "@/server/authz/actor";
import { assertPermission } from "@/server/authz/permissions";
import { managedTeamScope, ownedScope } from "@/server/authz/scope";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { ServiceContext } from "@/server/context";
import { isUniqueViolation } from "@/server/db/errors";
import {
  courses,
  LEAD_STAGES,
  LEAD_STATUSES,
  leadCycles,
  leadEvents,
  leadNotes,
  leads,
  teams,
  users,
  type LeadCycleKind,
  type LeadEventType,
  type LeadStage,
  type LeadStatus,
  type LeadUnassignedReason,
} from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { idSchema, nameSchema, parseInput } from "@/server/validation";
import { recordLeadEvents, supervisorOf } from "./leads.internal";

/**
 * Leads (Documento Mestre §5, §7, §9, §19; decisões C3–C12 e C15–C20 em
 * docs/ARQUITETURA.md).
 *
 * Escopo (ownedScope): SELLER vê só os próprios leads em operação; SUPERVISOR,
 * os da equipe que lidera (inclusive sem responsável e na Lixeira); ADMIN,
 * todos. Fora do escopo → NotFound, inclusive em busca por ID.
 *
 * Toda mudança grava lead_events na mesma transação. O banco ainda garante
 * (migration 002): telefone único, responsável SELLER ativo da mesma equipe,
 * coerência lead x ciclos, append-only e ausência de exclusão física.
 */

// ---------------------------------------------------------------------------
// Tipos de saída
// ---------------------------------------------------------------------------

export type LeadView = {
  id: string;
  name: string;
  /** Canônico (só dígitos). Formate com formatPhone de @/lib/phone. */
  phone: string;
  interestCourseId: string;
  interestCourseName: string;
  interestCourseInstitution: string;
  ownerId: string | null;
  ownerName: string | null;
  teamId: string;
  teamName: string;
  stage: LeadStage;
  stageEnteredAt: Date;
  stageDueAt: Date | null;
  status: LeadStatus;
  unassignedAt: Date | null;
  unassignedReason: LeadUnassignedReason | null;
  trashedAt: Date | null;
  /** Número do ciclo aberto (null na Lixeira). */
  cycleNumber: number | null;
  createdAt: Date;
};

export type DecisionQueueItem = LeadView & { queueReason: "UNASSIGNED" | "FOLLOW_UP_3_EXPIRED" };

export type LeadTimelineEntry = {
  id: number;
  type: LeadEventType;
  occurredAt: Date;
  actorName: string;
  cycleNumber: number;
  cycleKind: LeadCycleKind;
  stage: LeadStage;
  fromStage: LeadStage | null;
  ownerName: string | null;
  fromOwnerName: string | null;
  teamName: string;
  fromTeamName: string | null;
  supervisorName: string | null;
  fromSupervisorName: string | null;
  unassignedReason: LeadUnassignedReason | null;
  note: string | null;
  metadata: Record<string, unknown>;
};

type ExistingLead = { ownerName: string | null; teamName: string; inTrash: boolean };

const DUPLICATE_MESSAGES = {
  create: {
    inTrash: () => "Este lead já está cadastrado e encontra-se na Lixeira. Solicite ao supervisor ou administrador a recuperação.",
    owned: (e: ExistingLead) => `Este lead já está cadastrado. Responsável: ${e.ownerName} (equipe ${e.teamName}).`,
    unassigned: (e: ExistingLead) => `Este lead já está cadastrado e aguarda redistribuição pelo supervisor da equipe ${e.teamName}.`,
  },
  edit: {
    inTrash: () =>
      "Este telefone já pertence a um lead que está na Lixeira. Solicite ao supervisor ou administrador a recuperação daquele lead.",
    owned: (e: ExistingLead) => `Este telefone já pertence a outro lead. Responsável: ${e.ownerName} (equipe ${e.teamName}).`,
    unassigned: (e: ExistingLead) =>
      `Este telefone já pertence a outro lead, que aguarda redistribuição pelo supervisor da equipe ${e.teamName}.`,
  },
};

/**
 * Telefone já usado por outro lead (no cadastro ou na edição). Informa apenas
 * o mínimo (responsável e equipe, ou que está na Lixeira); não dá acesso ao
 * registro.
 */
export class LeadAlreadyExistsError extends ConflictError {
  constructor(
    readonly existing: ExistingLead,
    operation: "create" | "edit" = "create",
  ) {
    const messages = DUPLICATE_MESSAGES[operation];
    super(existing.inTrash ? messages.inTrash() : existing.ownerName ? messages.owned(existing) : messages.unassigned(existing));
  }
}

export const LEADS_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

const phoneSchema = z
  .string({ error: "Informe o telefone com DDD." })
  .max(40, "Telefone inválido.")
  .transform((value, ctx) => {
    const parsed = parseBrazilianPhone(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.error });
      return z.NEVER;
    }
    return parsed.phone;
  });

const createLeadSchema = z.strictObject({
  name: nameSchema,
  phone: phoneSchema,
  interestCourseId: idSchema,
});

/**
 * Edição: só nome, telefone e curso de interesse. Responsável, equipe, etapa,
 * situação, ciclo, prazos e Lixeira têm operações próprias (campos não
 * previstos são recusados).
 */
const editLeadSchema = z.strictObject({
  name: nameSchema.optional(),
  phone: phoneSchema.optional(),
  interestCourseId: idSchema.optional(),
});

const sellerChoiceSchema = z.strictObject({ toSellerId: idSchema });

const noteSchema = z.strictObject({
  body: z.string().trim().min(1, "Escreva a observação.").max(5000, "Use no máximo 5.000 caracteres."),
});

const listFiltersSchema = z.strictObject({
  status: z.enum(LEAD_STATUSES).optional(),
  stage: z.enum(LEAD_STAGES).optional(),
  ownerId: idSchema.optional(),
  teamId: idSchema.optional(),
  /** Apenas leads sem responsável (fila). */
  unassigned: z.boolean().optional(),
  /** Nome ou trecho do telefone. */
  search: z.string().trim().max(120).optional(),
});

// ---------------------------------------------------------------------------
// Escopo e consultas
// ---------------------------------------------------------------------------

/** Escopo de leitura: ownership/equipe e, para o vendedor, só leads ativos. */
function leadScope(actor: Actor): SQL | undefined {
  return and(
    ownedScope(actor, { ownerId: leads.ownerId, teamId: leads.teamId }),
    actor.role === "SELLER" ? eq(leads.status, "ACTIVE") : undefined,
  );
}

const owner = alias(users, "lead_owner");
const openCycle = alias(leadCycles, "open_cycle");

const leadView = {
  id: leads.id,
  name: leads.name,
  phone: leads.phone,
  interestCourseId: leads.interestCourseId,
  interestCourseName: courses.name,
  interestCourseInstitution: courses.institutionName,
  ownerId: leads.ownerId,
  ownerName: owner.name,
  teamId: leads.teamId,
  teamName: teams.name,
  stage: leads.stage,
  stageEnteredAt: leads.stageEnteredAt,
  stageDueAt: leads.stageDueAt,
  status: leads.status,
  unassignedAt: leads.unassignedAt,
  unassignedReason: leads.unassignedReason,
  trashedAt: leads.trashedAt,
  cycleNumber: openCycle.number,
  createdAt: leads.createdAt,
};

function selectLeadViews(db: Database) {
  return db
    .select(leadView)
    .from(leads)
    .innerJoin(courses, eq(courses.id, leads.interestCourseId))
    .innerJoin(teams, eq(teams.id, leads.teamId))
    .leftJoin(owner, eq(owner.id, leads.ownerId))
    .leftJoin(openCycle, and(eq(openCycle.leadId, leads.id), isNull(openCycle.endedAt)));
}

async function findLeadView(db: Database, actor: Actor, id: string): Promise<LeadView | undefined> {
  const [lead] = await selectLeadViews(db)
    .where(and(eq(leads.id, id), leadScope(actor)))
    .limit(1);
  return lead;
}

/** Lê e trava o lead para alteração, dentro do escopo do ator. */
async function lockLead(db: Database, actor: Actor, id: string) {
  const [lead] = await db
    .select({
      id: leads.id,
      name: leads.name,
      phone: leads.phone,
      interestCourseId: leads.interestCourseId,
      ownerId: leads.ownerId,
      teamId: leads.teamId,
      stage: leads.stage,
      stageDueAt: leads.stageDueAt,
      status: leads.status,
      unassignedReason: leads.unassignedReason,
    })
    .from(leads)
    .where(and(eq(leads.id, id), leadScope(actor)))
    .limit(1)
    .for("update");
  if (!lead) throw new NotFoundError();
  return lead;
}

async function currentCycle(db: Database, leadId: string): Promise<{ id: string; number: number }> {
  const [cycle] = await db
    .select({ id: leadCycles.id, number: leadCycles.number })
    .from(leadCycles)
    .where(and(eq(leadCycles.leadId, leadId), isNull(leadCycles.endedAt)))
    .limit(1);
  if (!cycle) throw new ValidationError("Este lead não está em atendimento.");
  return cycle;
}

async function latestCycle(db: Database, leadId: string): Promise<{ id: string; number: number }> {
  const [cycle] = await db
    .select({ id: leadCycles.id, number: leadCycles.number })
    .from(leadCycles)
    .where(eq(leadCycles.leadId, leadId))
    .orderBy(desc(leadCycles.number))
    .limit(1);
  return cycle;
}

/**
 * Vendedor escolhido para transferência, redistribuição ou recuperação:
 * SELLER ativo, com equipe. SUPERVISOR só escolhe vendedores da própria
 * equipe; ADMIN escolhe de qualquer equipe.
 */
async function loadTargetSeller(db: Database, actor: Actor, sellerId: string): Promise<{ id: string; teamId: string }> {
  const [seller] = await db
    .select({ id: users.id, role: users.role, active: users.active, teamId: users.teamId })
    .from(users)
    .where(eq(users.id, sellerId))
    .limit(1);
  const allowed =
    seller?.role === "SELLER" &&
    seller.active &&
    seller.teamId !== null &&
    (actor.role === "ADMIN" || seller.teamId === actor.supervisedTeamId);
  if (!allowed) {
    const message = actor.role === "ADMIN" ? "Selecione um vendedor ativo." : "Selecione um vendedor ativo da sua equipe.";
    throw new ValidationError(message, { toSellerId: [message] });
  }
  return { id: seller.id, teamId: seller.teamId! };
}

async function findDuplicate(db: Database, phone: string) {
  const [row] = await db
    .select({ status: leads.status, ownerName: owner.name, teamName: teams.name })
    .from(leads)
    .innerJoin(teams, eq(teams.id, leads.teamId))
    .leftJoin(owner, eq(owner.id, leads.ownerId))
    .where(eq(leads.phone, phone))
    .limit(1);
  return row && { ownerName: row.ownerName, teamName: row.teamName, inTrash: row.status === "TRASHED" };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export async function listLeads({ db, actor }: ServiceContext, rawFilters: unknown = {}): Promise<LeadView[]> {
  assertPermission(actor, "leads:view");
  const filters = parseInput(listFiltersSchema, rawFilters);

  const conditions: (SQL | undefined)[] = [leadScope(actor)];
  if (filters.status) conditions.push(eq(leads.status, filters.status));
  if (filters.stage) conditions.push(eq(leads.stage, filters.stage));
  if (filters.ownerId) conditions.push(eq(leads.ownerId, filters.ownerId));
  if (filters.teamId) conditions.push(eq(leads.teamId, filters.teamId));
  if (filters.unassigned) conditions.push(isNull(leads.ownerId));
  if (filters.search) {
    const term = `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`;
    const digits = phoneSearchDigits(filters.search);
    conditions.push(or(ilike(leads.name, term), digits.length >= 3 ? like(leads.phone, `%${digits}%`) : undefined));
  }

  return selectLeadViews(db)
    .where(and(...conditions))
    .orderBy(desc(leads.createdAt))
    .limit(LEADS_PAGE_SIZE);
}

export async function getLead({ db, actor }: ServiceContext, rawId: unknown): Promise<LeadView> {
  assertPermission(actor, "leads:view");
  const lead = await findLeadView(db, actor, parseInput(idSchema, rawId));
  if (!lead) throw new NotFoundError();
  return lead;
}

/** Linha do tempo completa do lead (todos os ciclos), para quem tem acesso a ele. */
export async function getLeadTimeline(ctx: ServiceContext, rawId: unknown): Promise<LeadTimelineEntry[]> {
  const lead = await getLead(ctx, rawId);

  const actorUser = alias(users, "event_actor");
  const ownerUser = alias(users, "event_owner");
  const fromOwnerUser = alias(users, "event_from_owner");
  const supervisorUser = alias(users, "event_supervisor");
  const fromSupervisorUser = alias(users, "event_from_supervisor");
  const team = alias(teams, "event_team");
  const fromTeam = alias(teams, "event_from_team");

  return ctx.db
    .select({
      id: leadEvents.id,
      type: leadEvents.type,
      occurredAt: leadEvents.occurredAt,
      actorName: actorUser.name,
      cycleNumber: leadCycles.number,
      cycleKind: leadCycles.kind,
      stage: leadEvents.stage,
      fromStage: leadEvents.fromStage,
      ownerName: ownerUser.name,
      fromOwnerName: fromOwnerUser.name,
      teamName: team.name,
      fromTeamName: fromTeam.name,
      supervisorName: supervisorUser.name,
      fromSupervisorName: fromSupervisorUser.name,
      unassignedReason: leadEvents.unassignedReason,
      note: leadNotes.body,
      metadata: leadEvents.metadata,
    })
    .from(leadEvents)
    .innerJoin(actorUser, eq(actorUser.id, leadEvents.actorId))
    .innerJoin(leadCycles, eq(leadCycles.id, leadEvents.cycleId))
    .innerJoin(team, eq(team.id, leadEvents.teamId))
    .leftJoin(ownerUser, eq(ownerUser.id, leadEvents.ownerId))
    .leftJoin(fromOwnerUser, eq(fromOwnerUser.id, leadEvents.fromOwnerId))
    .leftJoin(fromTeam, eq(fromTeam.id, leadEvents.fromTeamId))
    .leftJoin(supervisorUser, eq(supervisorUser.id, leadEvents.supervisorId))
    .leftJoin(fromSupervisorUser, eq(fromSupervisorUser.id, leadEvents.fromSupervisorId))
    .leftJoin(leadNotes, eq(leadNotes.id, leadEvents.noteId))
    .where(eq(leadEvents.leadId, lead.id))
    .orderBy(asc(leadEvents.id));
}

/**
 * Fila de decisão do supervisor (ADMIN: todas as equipes): leads sem
 * responsável (vendedor desativado) e leads com Follow-up 3 vencido. Nada é
 * gravado quando o prazo vence: a fila é calculada a partir de stage_due_at.
 */
export async function listDecisionQueue({ db, actor }: ServiceContext): Promise<DecisionQueueItem[]> {
  assertPermission(actor, "leads:transfer");
  const rows = await selectLeadViews(db)
    .where(
      and(
        managedTeamScope(actor, leads.teamId),
        eq(leads.status, "ACTIVE"),
        or(isNull(leads.ownerId), and(eq(leads.stage, "FOLLOW_UP_3"), lt(leads.stageDueAt, sql`now()`))),
      ),
    )
    .orderBy(asc(sql`coalesce(${leads.unassignedAt}, ${leads.stageDueAt})`));
  return rows.map((row) => ({ ...row, queueReason: row.ownerId === null ? "UNASSIGNED" : "FOLLOW_UP_3_EXPIRED" }));
}

// ---------------------------------------------------------------------------
// Cadastro (SELLER)
// ---------------------------------------------------------------------------

/**
 * Cadastra um lead na carteira do próprio vendedor, na etapa Lead Cadastrado,
 * com o ciclo 1. Telefone já existente (ativo, sem responsável ou na Lixeira)
 * → LeadAlreadyExistsError. A unicidade é garantida pela constraint do banco,
 * inclusive entre cadastros simultâneos.
 */
export async function createLead(ctx: ServiceContext, input: unknown): Promise<LeadView> {
  const { db, actor } = ctx;
  assertPermission(actor, "leads:create");
  const data = parseInput(createLeadSchema, input);
  const teamId = actor.teamId;
  if (!teamId) throw new ValidationError("Você não está vinculado a uma equipe. Procure o administrador.");

  const duplicate = await findDuplicate(db, data.phone);
  if (duplicate) throw new LeadAlreadyExistsError(duplicate);

  try {
    const id = await db.transaction(async (tx) => {
      const [course] = await tx.select({ active: courses.active }).from(courses).where(eq(courses.id, data.interestCourseId)).limit(1);
      if (!course?.active) {
        throw new ValidationError("Selecione um curso ativo.", { interestCourseId: ["Selecione um curso ativo."] });
      }

      const [lead] = await tx
        .insert(leads)
        .values({
          name: data.name,
          phone: data.phone,
          interestCourseId: data.interestCourseId,
          ownerId: actor.userId,
          teamId,
          createdBy: actor.userId,
        })
        .returning({ id: leads.id });
      const [cycle] = await tx
        .insert(leadCycles)
        .values({ leadId: lead.id, number: 1, kind: "INITIAL", assignedSellerId: actor.userId, teamId, startedBy: actor.userId })
        .returning({ id: leadCycles.id });
      await recordLeadEvents(tx, [
        {
          leadId: lead.id,
          cycleId: cycle.id,
          type: "CREATED",
          actorId: actor.userId,
          stage: "NEW",
          ownerId: actor.userId,
          teamId,
          supervisorId: await supervisorOf(tx, teamId),
        },
      ]);
      return lead.id;
    });
    return (await findLeadView(db, actor, id))!;
  } catch (error) {
    if (isUniqueViolation(error, "leads_phone_unique")) {
      const existing = await findDuplicate(db, data.phone);
      if (existing) throw new LeadAlreadyExistsError(existing);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Edição (nome, telefone e curso de interesse) — dentro do escopo de cada perfil
// ---------------------------------------------------------------------------

type CourseRef = { id: string; name: string; institutionName: string };

async function findCourse(db: Database, id: string): Promise<(CourseRef & { active: boolean }) | undefined> {
  const [course] = await db
    .select({ id: courses.id, name: courses.name, institutionName: courses.institutionName, active: courses.active })
    .from(courses)
    .where(eq(courses.id, id))
    .limit(1);
  return course;
}

const courseRef = ({ id, name, institutionName }: CourseRef): CourseRef => ({ id, name, institutionName });

/**
 * Edita nome, telefone e/ou curso de interesse. SELLER: próprios leads;
 * SUPERVISOR: leads da equipe; ADMIN: todos. Fora do escopo → NotFound; na
 * Lixeira → recusado (recupere primeiro). Não mexe em responsável, equipe,
 * etapa, prazos nem ciclo. Só grava (e só gera DETAILS_UPDATED, com de/para dos
 * campos alterados) se algo mudou de fato. Telefone já usado por outro lead,
 * inclusive na Lixeira → LeadAlreadyExistsError; a constraint UNIQUE do banco
 * é a garantia final contra edições simultâneas.
 */
export async function editLead(ctx: ServiceContext, rawId: unknown, input: unknown): Promise<LeadView> {
  const { db, actor } = ctx;
  assertPermission(actor, "leads:edit");
  const id = parseInput(idSchema, rawId);
  const data = parseInput(editLeadSchema, input);

  try {
    await db.transaction(async (tx) => {
      const lead = await lockLead(tx, actor, id);
      if (lead.status === "TRASHED") throw new ValidationError("Lead na Lixeira não pode ser editado. Recupere-o primeiro.");

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (data.name !== undefined && data.name !== lead.name) changes.name = { from: lead.name, to: data.name };
      if (data.phone !== undefined && data.phone !== lead.phone) {
        const duplicate = await findDuplicate(tx, data.phone);
        if (duplicate) throw new LeadAlreadyExistsError(duplicate, "edit");
        changes.phone = { from: lead.phone, to: data.phone };
      }
      if (data.interestCourseId !== undefined && data.interestCourseId !== lead.interestCourseId) {
        const [from, to] = await Promise.all([findCourse(tx, lead.interestCourseId), findCourse(tx, data.interestCourseId)]);
        if (!to?.active) {
          throw new ValidationError("Selecione um curso ativo.", { interestCourseId: ["Selecione um curso ativo."] });
        }
        changes.interestCourse = { from: courseRef(from!), to: courseRef(to) };
      }
      if (Object.keys(changes).length === 0) return;

      await tx
        .update(leads)
        .set({
          name: changes.name ? data.name : undefined,
          phone: changes.phone ? data.phone : undefined,
          interestCourseId: changes.interestCourse ? data.interestCourseId : undefined,
        })
        .where(eq(leads.id, lead.id));
      const cycle = await latestCycle(tx, lead.id);
      await recordLeadEvents(tx, [
        {
          leadId: lead.id,
          cycleId: cycle.id,
          type: "DETAILS_UPDATED",
          actorId: actor.userId,
          stage: lead.stage,
          ownerId: lead.ownerId,
          teamId: lead.teamId,
          supervisorId: await supervisorOf(tx, lead.teamId),
          metadata: changes,
        },
      ]);
    });
  } catch (error) {
    if (data.phone && isUniqueViolation(error, "leads_phone_unique")) {
      const existing = await findDuplicate(db, data.phone);
      if (existing) throw new LeadAlreadyExistsError(existing, "edit");
    }
    throw error;
  }
  return (await findLeadView(db, actor, id))!;
}

// ---------------------------------------------------------------------------
// Observações (vendedor responsável)
// ---------------------------------------------------------------------------

/**
 * Registra uma observação (append-only) no ciclo e etapa atuais. Em
 * Negociação, renova o prazo: registro + negotiationDeadlineHours.
 */
export async function addLeadNote({ db, actor }: ServiceContext, rawId: unknown, input: unknown): Promise<void> {
  assertPermission(actor, "leads:addNote");
  const id = parseInput(idSchema, rawId);
  const { body } = parseInput(noteSchema, input);

  await db.transaction(async (tx) => {
    const lead = await lockLead(tx, actor, id);
    const cycle = await currentCycle(tx, lead.id);
    const [note] = await tx
      .insert(leadNotes)
      .values({ leadId: lead.id, cycleId: cycle.id, stage: lead.stage, authorId: actor.userId, body })
      .returning({ id: leadNotes.id, createdAt: leadNotes.createdAt });

    let renewedDueAt: Date | null = null;
    if (lead.stage === "NEGOTIATION") {
      renewedDueAt = new Date(note.createdAt.getTime() + BUSINESS_RULES.negotiationDeadlineHours * 3_600_000);
      await tx.update(leads).set({ stageDueAt: renewedDueAt }).where(eq(leads.id, lead.id));
    }

    await recordLeadEvents(tx, [
      {
        leadId: lead.id,
        cycleId: cycle.id,
        type: "NOTE_ADDED",
        actorId: actor.userId,
        stage: lead.stage,
        ownerId: lead.ownerId,
        teamId: lead.teamId,
        supervisorId: await supervisorOf(tx, lead.teamId),
        noteId: note.id,
        metadata: renewedDueAt ? { renewedDueAt: renewedDueAt.toISOString() } : {},
      },
    ]);
  });
}

// ---------------------------------------------------------------------------
// Transferência (SUPERVISOR na própria equipe; ADMIN entre equipes)
// ---------------------------------------------------------------------------

/**
 * Troca o vendedor responsável. Mantém etapa, entrada na etapa, prazo e ciclo
 * (não é Retrabalho). Também é a "transferência administrativa" de um lead que
 * ficou sem responsável pela desativação do vendedor.
 */
export async function transferLead({ db, actor }: ServiceContext, rawId: unknown, input: unknown): Promise<void> {
  assertPermission(actor, "leads:transfer");
  const id = parseInput(idSchema, rawId);
  const { toSellerId } = parseInput(sellerChoiceSchema, input);

  await db.transaction(async (tx) => {
    const lead = await lockLead(tx, actor, id);
    if (lead.status !== "ACTIVE") throw new ValidationError("Lead na Lixeira não pode ser transferido. Recupere-o primeiro.");
    if (lead.stage === "CLOSED") throw new ValidationError("Lead em Fechamento não pode ser transferido.");
    const seller = await loadTargetSeller(tx, actor, toSellerId);
    if (seller.id === lead.ownerId) throw new ValidationError("O lead já está com este vendedor.");

    const cycle = await currentCycle(tx, lead.id);
    const teamChanged = seller.teamId !== lead.teamId;
    const [fromSupervisorId, supervisorId] = await Promise.all([supervisorOf(tx, lead.teamId), supervisorOf(tx, seller.teamId)]);

    await tx
      .update(leads)
      .set({ ownerId: seller.id, teamId: seller.teamId, unassignedAt: null, unassignedReason: null })
      .where(eq(leads.id, lead.id));
    await recordLeadEvents(tx, [
      {
        leadId: lead.id,
        cycleId: cycle.id,
        type: "TRANSFERRED",
        actorId: actor.userId,
        stage: lead.stage,
        ownerId: seller.id,
        fromOwnerId: lead.ownerId,
        teamId: seller.teamId,
        fromTeamId: teamChanged ? lead.teamId : null,
        supervisorId,
        fromSupervisorId: teamChanged ? fromSupervisorId : null,
        metadata: lead.ownerId === null ? { fromQueue: true, unassignedReason: lead.unassignedReason } : {},
      },
    ]);
  });
}

// ---------------------------------------------------------------------------
// Redistribuição / Retrabalho e Lixeira (SUPERVISOR na própria equipe; ADMIN)
// ---------------------------------------------------------------------------

/**
 * Nova tentativa comercial após Follow-up 3 vencido: encerra o ciclo atual
 * (REDISTRIBUTED), abre o ciclo seguinte (REWORK) para o vendedor escolhido e
 * coloca o lead em Retrabalho, sem prazo.
 */
export async function redistributeLead({ db, actor }: ServiceContext, rawId: unknown, input: unknown): Promise<void> {
  assertPermission(actor, "leads:redistribute");
  const id = parseInput(idSchema, rawId);
  const { toSellerId } = parseInput(sellerChoiceSchema, input);

  await db.transaction(async (tx) => {
    const lead = await lockLead(tx, actor, id);
    const followUp3Expired =
      lead.status === "ACTIVE" && lead.stage === "FOLLOW_UP_3" && lead.stageDueAt !== null && lead.stageDueAt < new Date();
    if (!followUp3Expired) throw new ValidationError("Só é possível redistribuir leads com Follow-up 3 vencido.");
    const seller = await loadTargetSeller(tx, actor, toSellerId);

    const cycle = await currentCycle(tx, lead.id);
    await tx
      .update(leadCycles)
      .set({ endedAt: sql`now()`, endedBy: actor.userId, endReason: "REDISTRIBUTED" })
      .where(eq(leadCycles.id, cycle.id));
    await startReworkCycle(tx, actor, lead, seller, cycle.number + 1, "REDISTRIBUTED");
  });
}

/** Envia para a Lixeira: encerra o ciclo (TRASHED) e preserva etapa, responsável e telefone. */
export async function trashLead({ db, actor }: ServiceContext, rawId: unknown): Promise<void> {
  assertPermission(actor, "leads:trash");
  const id = parseInput(idSchema, rawId);

  await db.transaction(async (tx) => {
    const lead = await lockLead(tx, actor, id);
    if (lead.status === "TRASHED") throw new ValidationError("O lead já está na Lixeira.");
    if (lead.stage === "CLOSED") throw new ValidationError("Lead em Fechamento não pode ir para a Lixeira.");

    const cycle = await currentCycle(tx, lead.id);
    await tx
      .update(leadCycles)
      .set({ endedAt: sql`now()`, endedBy: actor.userId, endReason: "TRASHED" })
      .where(eq(leadCycles.id, cycle.id));
    await tx
      .update(leads)
      .set({ status: "TRASHED", trashedAt: sql`now()`, trashedBy: actor.userId })
      .where(eq(leads.id, lead.id));
    await recordLeadEvents(tx, [
      {
        leadId: lead.id,
        cycleId: cycle.id,
        type: "TRASHED",
        actorId: actor.userId,
        stage: lead.stage,
        ownerId: lead.ownerId,
        teamId: lead.teamId,
        supervisorId: await supervisorOf(tx, lead.teamId),
      },
    ]);
  });
}

/** Recupera da Lixeira: novo ciclo REWORK para o vendedor escolhido, etapa Retrabalho. */
export async function restoreLead({ db, actor }: ServiceContext, rawId: unknown, input: unknown): Promise<void> {
  assertPermission(actor, "leads:restore");
  const id = parseInput(idSchema, rawId);
  const { toSellerId } = parseInput(sellerChoiceSchema, input);

  await db.transaction(async (tx) => {
    const lead = await lockLead(tx, actor, id);
    if (lead.status !== "TRASHED") throw new ValidationError("O lead não está na Lixeira.");
    const seller = await loadTargetSeller(tx, actor, toSellerId);
    const last = await latestCycle(tx, lead.id);
    await startReworkCycle(tx, actor, lead, seller, last.number + 1, "RESTORED");
  });
}

async function startReworkCycle(
  tx: Database,
  actor: Actor,
  lead: { id: string; ownerId: string | null; teamId: string; stage: LeadStage },
  seller: { id: string; teamId: string },
  number: number,
  type: "REDISTRIBUTED" | "RESTORED",
): Promise<void> {
  const [cycle] = await tx
    .insert(leadCycles)
    .values({ leadId: lead.id, number, kind: "REWORK", assignedSellerId: seller.id, teamId: seller.teamId, startedBy: actor.userId })
    .returning({ id: leadCycles.id });

  await tx
    .update(leads)
    .set({
      ownerId: seller.id,
      teamId: seller.teamId,
      unassignedAt: null,
      unassignedReason: null,
      stage: "REWORK",
      stageEnteredAt: sql`now()`,
      stageDueAt: null,
      status: "ACTIVE",
      trashedAt: null,
      trashedBy: null,
    })
    .where(eq(leads.id, lead.id));

  const teamChanged = seller.teamId !== lead.teamId;
  const [fromSupervisorId, supervisorId] = await Promise.all([supervisorOf(tx, lead.teamId), supervisorOf(tx, seller.teamId)]);
  await recordLeadEvents(tx, [
    {
      leadId: lead.id,
      cycleId: cycle.id,
      type,
      actorId: actor.userId,
      stage: "REWORK",
      fromStage: lead.stage,
      ownerId: seller.id,
      fromOwnerId: lead.ownerId,
      teamId: seller.teamId,
      fromTeamId: teamChanged ? lead.teamId : null,
      supervisorId,
      fromSupervisorId: teamChanged ? fromSupervisorId : null,
    },
  ]);
}
