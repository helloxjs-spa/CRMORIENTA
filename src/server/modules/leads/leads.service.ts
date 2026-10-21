import { and, asc, count, desc, eq, ilike, isNotNull, isNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { parseBrazilianPhone, phoneSearchDigits } from "@/lib/phone";
import { conversionRate } from "@/lib/dashboard";
import { canTransition, LEAD_PAGE_SIZES, STAGE_LABELS, STAGE_ORDER, STAGES_WITH_DEADLINE, type LeadQueueReason } from "@/lib/leads";
import type { Actor } from "@/server/authz/actor";
import { assertPermission, hasPermission } from "@/server/authz/permissions";
import { ownedScope } from "@/server/authz/scope";
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
  sales,
  teams,
  users,
  type LeadCycleKind,
  type LeadEventType,
  type LeadStage,
  type LeadStatus,
  type LeadUnassignedReason,
} from "@/server/db/schema";
import { RetryTransactionError, runTransaction } from "@/server/db/transaction";
import type { Database } from "@/server/db/types";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { idSchema, nameSchema, parseInput } from "@/server/validation";
import { lockTeamsForShare, lockUsersForChange, recordLeadEvents, supervisorOf, type LeadEventInput } from "./leads.internal";

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
  trashedByName: string | null;
  /** Número do ciclo aberto (null na Lixeira). */
  cycleNumber: number | null;
  createdAt: Date;
  /**
   * Lead que aguarda decisão do supervisor: sem responsável (vendedor
   * desativado) ou com Follow-up 3 vencido. Calculado a cada leitura.
   */
  queueReason: LeadQueueReason | null;
};

export type { LeadQueueReason };

export type Paginated<T> = { items: T[]; page: number; pageSize: number; total: number; totalPages: number };

export type DecisionQueueCounts = { unassigned: number; followUp3Expired: number };

/** Vendedor no escopo do ator (filtro por vendedor e escolha de destino). */
export type LeadSellerOption = { id: string; name: string; active: boolean; teamId: string | null; teamName: string | null };

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
  /** Venda do evento (SALE_*), para o link na linha do tempo. */
  saleId: string | null;
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


/** Cadastro de lead por vendedor cuja equipe está inativa. */
export const OWN_TEAM_INACTIVE = "Sua equipe está inativa. Procure o administrador.";

/** Cadastro por SUPERVISOR/ADMIN sem vendedor responsável. */
export const LEAD_SELLER_REQUIRED = "Selecione o vendedor responsável pelo lead.";
/** SELLER só cadastra leads na própria carteira. */
export const LEAD_SELLER_SELF_ONLY = "Você cadastra leads apenas na sua carteira.";

/** Lead com Follow-up 3 vencido: somente leitura para o vendedor (C27/C32). */
export const AWAITING_SUPERVISOR_MESSAGE =
  "Este lead aguarda a decisão do supervisor (Follow-up 3 vencido). Você pode consultá-lo, mas não alterá-lo.";

/**
 * Vendedor com negociação vencida: não cadastra leads nem movimenta outros
 * leads até atualizar a(s) negociação(ões) (Documento Mestre §8; C34).
 */
export class NegotiationOverdueError extends ConflictError {
  constructor(readonly overdueCount: number) {
    super(
      overdueCount === 1
        ? "Você possui uma negociação vencida. Atualize-a para continuar cadastrando ou movimentando leads."
        : `Você possui ${overdueCount} negociações vencidas. Atualize-as para continuar cadastrando ou movimentando leads.`,
    );
  }
}

export type NegotiationBlock = { count: number; leads: { id: string; name: string; stageDueAt: Date }[] };

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
  /** Vendedor responsável: obrigatório para SUPERVISOR/ADMIN; o SELLER cadastra para si (C41). */
  sellerId: idSchema.optional(),
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

const moveStageSchema = z.strictObject({ toStage: z.enum(LEAD_STAGES, { error: "Etapa inválida." }) });

const noteSchema = z.strictObject({
  body: z.string().trim().min(1, "Escreva a observação.").max(5000, "Use no máximo 5.000 caracteres."),
});

const listFiltersSchema = z.strictObject({
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.union(LEAD_PAGE_SIZES.map((size) => z.literal(size))).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  stage: z.enum(LEAD_STAGES).optional(),
  courseId: idSchema.optional(),
  ownerId: idSchema.optional(),
  teamId: idSchema.optional(),
  /** Fila de decisão (SUPERVISOR/ADMIN): todos os motivos ou um deles. */
  queue: z.enum(["ALL", "UNASSIGNED", "FOLLOW_UP_3_EXPIRED"]).optional(),
  /** Nome ou trecho do telefone (aceita o telefone formatado). */
  search: z.string().trim().max(120).optional(),
  /** "deadline": prazo mais próximo primeiro (Kanban); padrão: mais recentes. */
  order: z.enum(["recent", "deadline"]).optional(),
  /** Data de cadastro (dia no fuso do negócio, como no Dashboard), inclusive. */
  createdFrom: z.iso.date({ error: "Data inválida." }).optional(),
  createdTo: z.iso.date({ error: "Data inválida." }).optional(),
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
const trasher = alias(users, "lead_trasher");
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
  trashedByName: trasher.name,
  cycleNumber: openCycle.number,
  createdAt: leads.createdAt,
};

/** Condições da fila de decisão (sempre combinadas com o escopo). */
const queueConditions = {
  UNASSIGNED: and(eq(leads.status, "ACTIVE"), isNull(leads.ownerId)),
  FOLLOW_UP_3_EXPIRED: and(
    eq(leads.status, "ACTIVE"),
    isNotNull(leads.ownerId),
    eq(leads.stage, "FOLLOW_UP_3"),
    lt(leads.stageDueAt, sql`now()`),
  ),
};

type QueueFields = { status: LeadStatus; ownerId: string | null; stage: LeadStage; stageDueAt: Date | null };

function queueReasonOf(lead: QueueFields, now: Date): LeadQueueReason | null {
  if (lead.status !== "ACTIVE") return null;
  if (lead.ownerId === null) return "UNASSIGNED";
  if (lead.stage === "FOLLOW_UP_3" && lead.stageDueAt !== null && lead.stageDueAt < now) return "FOLLOW_UP_3_EXPIRED";
  return null;
}

function withQueueReason<T extends QueueFields>(rows: T[]): (T & { queueReason: LeadQueueReason | null })[] {
  const now = new Date();
  return rows.map((row) => ({ ...row, queueReason: queueReasonOf(row, now) }));
}

function selectLeadViews(db: Database) {
  return db
    .select(leadView)
    .from(leads)
    .innerJoin(courses, eq(courses.id, leads.interestCourseId))
    .innerJoin(teams, eq(teams.id, leads.teamId))
    .leftJoin(owner, eq(owner.id, leads.ownerId))
    .leftJoin(trasher, eq(trasher.id, leads.trashedBy))
    .leftJoin(openCycle, and(eq(openCycle.leadId, leads.id), isNull(openCycle.endedAt)));
}

async function findLeadView(db: Database, actor: Actor, id: string): Promise<LeadView | undefined> {
  const rows = await selectLeadViews(db)
    .where(and(eq(leads.id, id), leadScope(actor)))
    .limit(1);
  return withQueueReason(rows)[0];
}

/** Lê e trava o lead para alteração, dentro do escopo informado (undefined = sem restrição). */
async function lockLead(db: Database, id: string, scope: SQL | undefined) {
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
    .where(and(eq(leads.id, id), scope))
    .limit(1)
    .for("update");
  if (!lead) throw new NotFoundError();
  return lead;
}

/**
 * Travas de toda mutação de lead, na ordem global usuários → lead (a mesma
 * dos triggers do 003 e de users.service; a inversão lead → vendedor causava
 * o deadlock P11 com a desativação/troca de equipe do vendedor):
 *   1. lê o lead (com escopo, sem trava) só para saber o responsável atual;
 *   2. trava ator, responsável e vendedores de destino (lockUsersForChange);
 *   3. trava as equipes do lead, do responsável e dos vendedores de destino
 *      (lockTeamsForShare): o supervisor gravado nos eventos fica estável até
 *      o COMMIT;
 *   4. trava o lead (escopo de novo, FOR UPDATE).
 * Se o responsável ou a equipe do lead mudaram entre 1 e 4, o conjunto
 * travado não é mais o certo: a transação inteira é refeita
 * (RetryTransactionError). Todas as decisões usam o lead travado, nunca a
 * leitura do passo 1.
 *
 * Exportada para o módulo de Vendas (createSale), que segue a mesma ordem e
 * depois trava a venda e os itens.
 */
export async function lockLeadForChange(db: Database, actor: Actor, id: string, targetSellerIds: string[] = []) {
  return lockLeadInOrder(db, actor, id, targetSellerIds, leadScope(actor));
}

/**
 * Igual a lockLeadForChange, mas SEM o escopo de lead: para operações sobre
 * uma venda já autorizada pelo escopo da VENDA (equipe atual do vendedor
 * responsável), cujo lead pode estar com outro responsável ou em outra equipe.
 */
export async function lockLeadForSale(db: Database, actor: Actor, id: string, targetSellerIds: string[] = []) {
  return lockLeadInOrder(db, actor, id, targetSellerIds, undefined);
}

async function lockLeadInOrder(db: Database, actor: Actor, id: string, targetSellerIds: string[], scope: SQL | undefined) {
  const [seen] = await db
    .select({ ownerId: leads.ownerId, teamId: leads.teamId })
    .from(leads)
    .where(and(eq(leads.id, id), scope))
    .limit(1);
  if (!seen) throw new NotFoundError();
  const lockedUsers = await lockUsersForChange(db, actor, [seen.ownerId, ...targetSellerIds]);
  await lockTeamsForShare(db, [
    seen.teamId,
    seen.ownerId ? lockedUsers.get(seen.ownerId)?.teamId : null,
    ...targetSellerIds.map((sellerId) => lockedUsers.get(sellerId)?.teamId),
  ]);
  const lead = await lockLead(db, id, scope);
  if (lead.ownerId !== seen.ownerId || lead.teamId !== seen.teamId) throw new RetryTransactionError();
  return lead;
}

export type LockedLead = Awaited<ReturnType<typeof lockLead>>;

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

/** Vendedor de equipe inativa não recebe leads novos (regularizar a equipe ou o vendedor antes). */
export const TARGET_TEAM_INACTIVE = "A equipe do vendedor selecionado está inativa.";

/**
 * Vendedor escolhido para transferência, redistribuição ou recuperação (ele e
 * a equipe dele já travados por lockLeadForChange: a leitura não muda até o
 * COMMIT): SELLER ativo, com equipe ATIVA. SUPERVISOR só escolhe vendedores da
 * própria equipe; ADMIN escolhe de qualquer equipe.
 */
async function loadTargetSeller(
  db: Database,
  actor: Actor,
  sellerId: string,
  field = "toSellerId",
): Promise<{ id: string; teamId: string }> {
  const [seller] = await db
    .select({ id: users.id, role: users.role, active: users.active, teamId: users.teamId, teamActive: teams.active })
    .from(users)
    .leftJoin(teams, eq(teams.id, users.teamId))
    .where(eq(users.id, sellerId))
    .limit(1);
  const allowed =
    seller?.role === "SELLER" &&
    seller.active &&
    seller.teamId !== null &&
    (actor.role === "ADMIN" || seller.teamId === actor.supervisedTeamId);
  if (!allowed) {
    const message = actor.role === "ADMIN" ? "Selecione um vendedor ativo." : "Selecione um vendedor ativo da sua equipe.";
    throw new ValidationError(message, { [field]: [message] });
  }
  if (!seller.teamActive) throw new ValidationError(TARGET_TEAM_INACTIVE, { [field]: [TARGET_TEAM_INACTIVE] });
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

/**
 * Listagem paginada no banco: o escopo do ator entra no WHERE junto com os
 * filtros (filtrar por outro vendedor/equipe fora do escopo devolve vazio) e
 * a contagem usa exatamente as mesmas condições.
 */
export async function listLeads({ db, actor }: ServiceContext, rawFilters: unknown = {}): Promise<Paginated<LeadView>> {
  assertPermission(actor, "leads:view");
  const filters = parseInput(listFiltersSchema, rawFilters);
  if (filters.queue) assertPermission(actor, "leads:transfer");

  const conditions: (SQL | undefined)[] = [leadScope(actor)];
  if (filters.status) conditions.push(eq(leads.status, filters.status));
  if (filters.stage) conditions.push(eq(leads.stage, filters.stage));
  if (filters.courseId) conditions.push(eq(leads.interestCourseId, filters.courseId));
  if (filters.ownerId) conditions.push(eq(leads.ownerId, filters.ownerId));
  if (filters.teamId) conditions.push(eq(leads.teamId, filters.teamId));
  const createdDay = sql`(${leads.createdAt} at time zone ${BUSINESS_RULES.timezone})::date`;
  if (filters.createdFrom) conditions.push(sql`${createdDay} >= ${filters.createdFrom}::date`);
  if (filters.createdTo) conditions.push(sql`${createdDay} <= ${filters.createdTo}::date`);
  if (filters.queue) {
    conditions.push(
      filters.queue === "ALL" ? or(queueConditions.UNASSIGNED, queueConditions.FOLLOW_UP_3_EXPIRED) : queueConditions[filters.queue],
    );
  }
  if (filters.search) {
    const term = `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`;
    const digits = phoneSearchDigits(filters.search);
    conditions.push(or(ilike(leads.name, term), digits.length >= 3 ? like(leads.phone, `%${digits}%`) : undefined));
  }
  const where = and(...conditions);

  const [{ total }] = await db.select({ total: count() }).from(leads).where(where);
  const pageSize = filters.pageSize ?? LEAD_PAGE_SIZES[0];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(filters.page ?? 1, totalPages);

  const order = filters.queue
    ? [asc(sql`coalesce(${leads.unassignedAt}, ${leads.stageDueAt})`), asc(leads.id)]
    : filters.order === "deadline"
      ? [sql`${leads.stageDueAt} asc nulls last`, desc(leads.createdAt), desc(leads.id)]
      : filters.status === "TRASHED"
      ? [desc(leads.trashedAt), desc(leads.id)]
      : [desc(leads.createdAt), desc(leads.id)];
  const rows =
    total === 0
      ? []
      : await selectLeadViews(db)
          .where(where)
          .orderBy(...order)
          .limit(pageSize)
          .offset((page - 1) * pageSize);

  return { items: withQueueReason(rows), page, pageSize, total, totalPages };
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
      saleId: leadEvents.saleId,
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
 * Contagem da fila de decisão do supervisor (ADMIN: todas as equipes): leads
 * sem responsável (vendedor desativado) e com Follow-up 3 vencido. Nada é
 * gravado quando o prazo vence: a fila é calculada a partir de stage_due_at.
 * Os itens vêm de listLeads({ queue }).
 */
export async function countDecisionQueue({ db, actor }: ServiceContext): Promise<DecisionQueueCounts> {
  assertPermission(actor, "leads:transfer");
  const [row] = await db
    .select({
      unassigned: sql<number>`count(*) filter (where ${queueConditions.UNASSIGNED})`.mapWith(Number),
      followUp3Expired: sql<number>`count(*) filter (where ${queueConditions.FOLLOW_UP_3_EXPIRED})`.mapWith(Number),
    })
    .from(leads)
    .where(leadScope(actor));
  return row;
}

/**
 * Vendedores no escopo do ator, para filtros e para escolher o destino de
 * transferência, redistribuição ou recuperação. SUPERVISOR: os da equipe que
 * lidera; ADMIN: todos. Quem pode receber um lead é decidido de novo no
 * serviço da operação (vendedor ativo, da equipe permitida).
 */
export async function listLeadSellers({ db, actor }: ServiceContext): Promise<LeadSellerOption[]> {
  assertPermission(actor, "leads:transfer");
  if (actor.role === "SUPERVISOR" && !actor.supervisedTeamId) return [];
  return db
    .select({ id: users.id, name: users.name, active: users.active, teamId: users.teamId, teamName: teams.name })
    .from(users)
    .leftJoin(teams, eq(teams.id, users.teamId))
    .where(and(eq(users.role, "SELLER"), actor.role === "SUPERVISOR" ? eq(users.teamId, actor.supervisedTeamId!) : undefined))
    .orderBy(asc(teams.name), asc(users.name));
}

// ---------------------------------------------------------------------------
// Indicadores do Dashboard (§17) — mesmo escopo de leitura de listLeads
// ---------------------------------------------------------------------------

export type LeadIndicators = {
  /** Leads cadastrados no período (data de cadastro no fuso do negócio). */
  createdInPeriod: number;
  /** Desses, quantos têm pelo menos uma venda válida (cada lead conta uma vez). */
  convertedInPeriod: number;
  /**
   * Desses, quantos estão hoje na Lixeira (já incluídos em createdInPeriod; só
   * para quem vê leads na Lixeira — SELLER sempre 0). Lead na Lixeira nunca tem
   * venda válida (o banco exige lead ativo em Fechamento), então não entra no
   * numerador da conversão.
   */
  trashedInPeriod: number;
  /** Denominador da conversão: leads cadastrados no período que NÃO estão hoje na Lixeira (#28). */
  conversionBase: number;
  /** % = convertidos ÷ conversionBase × 100; null sem leads elegíveis. */
  conversionRate: number | null;
  /** Carteira ATUAL (leads ativos agora), por etapa — independe do período. */
  portfolio: { stage: LeadStage; count: number }[];
  alerts: {
    /** Follow-up 1/2/3 com prazo vencido (inclui Follow-up 3 aguardando o supervisor). */
    followUpsOverdue: number;
    negotiationsOverdue: number;
    /** Fila de decisão do supervisor/admin; null para quem não decide (SELLER). */
    awaitingDecision: DecisionQueueCounts | null;
  };
};

const indicatorPeriodSchema = z
  .strictObject({ dateFrom: z.iso.date({ error: "Data inválida." }), dateTo: z.iso.date({ error: "Data inválida." }) })
  .refine((value) => value.dateFrom <= value.dateTo, { path: ["dateTo"], message: "A data inicial deve ser igual ou anterior à final." });

/**
 * Indicadores de leads no escopo de leitura do ator (o mesmo de listLeads:
 * SELLER os próprios ativos; SUPERVISOR os da equipe que lidera; ADMIN todos).
 * Cadastrados no período × carteira atual são números separados. Conversão =
 * leads cadastrados no período com venda válida (qualquer data, cada lead uma
 * vez) ÷ leads cadastrados no período que não estão hoje na Lixeira (#28).
 */
export async function getLeadIndicators({ db, actor }: ServiceContext, input: unknown): Promise<LeadIndicators> {
  assertPermission(actor, "leads:view");
  const { dateFrom, dateTo } = parseInput(indicatorPeriodSchema, input);
  const scope = leadScope(actor);
  const createdDay = sql`(${leads.createdAt} at time zone ${BUSINESS_RULES.timezone})::date`;
  const hasValidSale = sql`exists (select 1 from ${sales} where ${sales.leadId} = ${leads.id} and ${sales.status} = 'ACTIVE')`;

  const [created] = await db
    .select({
      total: sql<number>`count(*)::int`,
      converted: sql<number>`(count(*) filter (where ${hasValidSale}))::int`,
      trashed: sql<number>`(count(*) filter (where ${leads.status} = 'TRASHED'))::int`,
      eligible: sql<number>`(count(*) filter (where ${leads.status} = 'ACTIVE'))::int`,
    })
    .from(leads)
    .where(and(scope, sql`${createdDay} between ${dateFrom}::date and ${dateTo}::date`));

  const byStage = await db
    .select({ stage: leads.stage, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(scope, eq(leads.status, "ACTIVE")))
    .groupBy(leads.stage);
  const counts = new Map(byStage.map((row) => [row.stage, row.count]));

  const overdue = and(eq(leads.status, "ACTIVE"), isNotNull(leads.ownerId), lt(leads.stageDueAt, sql`now()`));
  const [alerts] = await db
    .select({
      followUpsOverdue: sql<number>`(count(*) filter (where ${leads.stage} in ('FOLLOW_UP_1', 'FOLLOW_UP_2', 'FOLLOW_UP_3')))::int`,
      negotiationsOverdue: sql<number>`(count(*) filter (where ${leads.stage} = 'NEGOTIATION'))::int`,
    })
    .from(leads)
    .where(and(scope, overdue));

  return {
    createdInPeriod: created.total,
    convertedInPeriod: created.converted,
    trashedInPeriod: created.trashed,
    conversionBase: created.eligible,
    conversionRate: conversionRate(created.converted, created.eligible),
    portfolio: STAGE_ORDER.map((stage) => ({ stage, count: counts.get(stage) ?? 0 })),
    alerts: {
      followUpsOverdue: alerts.followUpsOverdue,
      negotiationsOverdue: alerts.negotiationsOverdue,
      awaitingDecision: hasPermission(actor, "leads:transfer") ? await countDecisionQueue({ db, actor }) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Travas operacionais do vendedor
// ---------------------------------------------------------------------------

/** Negociações vencidas do vendedor (ativas, prazo no passado), mais antigas primeiro. */
async function overdueNegotiations(db: Database, sellerId: string, exceptLeadId?: string) {
  return db
    .select({ id: leads.id, name: leads.name, stageDueAt: leads.stageDueAt })
    .from(leads)
    .where(
      and(
        eq(leads.ownerId, sellerId),
        eq(leads.stage, "NEGOTIATION"),
        eq(leads.status, "ACTIVE"),
        lt(leads.stageDueAt, sql`now()`),
        exceptLeadId ? sql`${leads.id} <> ${exceptLeadId}` : undefined,
      ),
    )
    .orderBy(asc(leads.stageDueAt));
}

/** SELLER com negociação vencida (fora `exceptLeadId`) → NegotiationOverdueError. */
async function assertNoOverdueNegotiation(db: Database, actor: Actor, exceptLeadId?: string): Promise<void> {
  if (actor.role !== "SELLER") return;
  const overdue = await overdueNegotiations(db, actor.userId, exceptLeadId);
  if (overdue.length > 0) throw new NegotiationOverdueError(overdue.length);
}

/** Follow-up 3 vencido: o vendedor só consulta; quem decide é o supervisor. */
function assertSellerMayChange(actor: Actor, lead: QueueFields): void {
  if (actor.role === "SELLER" && queueReasonOf(lead, new Date()) === "FOLLOW_UP_3_EXPIRED") {
    throw new ConflictError(AWAITING_SUPERVISOR_MESSAGE);
  }
}

/**
 * Bloqueio por negociação vencida do vendedor logado (para o aviso da tela).
 * null para quem não tem carteira.
 */
export async function getNegotiationBlock({ db, actor }: ServiceContext): Promise<NegotiationBlock | null> {
  assertPermission(actor, "leads:view");
  if (actor.role !== "SELLER") return null;
  const overdue = await overdueNegotiations(db, actor.userId);
  return {
    count: overdue.length,
    leads: overdue.map((l) => ({ id: l.id, name: l.name, stageDueAt: l.stageDueAt! })),
  };
}

// ---------------------------------------------------------------------------
// Cadastro (SELLER, SUPERVISOR, ADMIN — C41)
// ---------------------------------------------------------------------------

/**
 * Cadastra um lead na etapa Lead Cadastrado, com o ciclo 1. SELLER: na
 * própria carteira (equipe dele). SUPERVISOR/ADMIN: na carteira do vendedor
 * escolhido, com as mesmas regras da transferência (SUPERVISOR só da equipe
 * que lidera; ADMIN qualquer um; vendedor ativo de equipe ativa); a equipe do
 * lead é a do vendedor. Telefone já existente (ativo, sem responsável ou na
 * Lixeira) → LeadAlreadyExistsError. A unicidade é garantida pela constraint
 * do banco, inclusive entre cadastros simultâneos.
 */
export async function createLead(ctx: ServiceContext, input: unknown): Promise<LeadView> {
  const { db, actor } = ctx;
  assertPermission(actor, "leads:create");
  const data = parseInput(createLeadSchema, input);
  const sellerActor = actor.role === "SELLER";
  if (sellerActor) {
    if (data.sellerId !== undefined && data.sellerId !== actor.userId) {
      throw new ValidationError(LEAD_SELLER_SELF_ONLY, { sellerId: [LEAD_SELLER_SELF_ONLY] });
    }
    if (!actor.teamId) throw new ValidationError("Você não está vinculado a uma equipe. Procure o administrador.");
  } else if (!data.sellerId) {
    throw new ValidationError(LEAD_SELLER_REQUIRED, { sellerId: [LEAD_SELLER_REQUIRED] });
  }
  const ownerId = sellerActor ? actor.userId : data.sellerId!;
  await assertNoOverdueNegotiation(db, actor);

  const duplicate = await findDuplicate(db, data.phone);
  if (duplicate) throw new LeadAlreadyExistsError(duplicate);

  try {
    const id = await runTransaction(db, async (tx) => {
      // Mesma ordem das demais mutações: usuários → equipe (o supervisor
      // gravado no evento fica estável até o COMMIT) → lead.
      await lockUsersForChange(tx, actor, [ownerId]);
      const teamId = sellerActor ? actor.teamId! : (await loadTargetSeller(tx, actor, ownerId, "sellerId")).teamId;
      const team = (await lockTeamsForShare(tx, [teamId])).get(teamId);
      // Vendedor de equipe inativa não recebe leads novos.
      if (!team?.active) {
        if (sellerActor) throw new ValidationError(OWN_TEAM_INACTIVE);
        throw new ValidationError(TARGET_TEAM_INACTIVE, { sellerId: [TARGET_TEAM_INACTIVE] });
      }
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
          ownerId,
          teamId,
          createdBy: actor.userId,
        })
        .returning({ id: leads.id });
      const [cycle] = await tx
        .insert(leadCycles)
        .values({ leadId: lead.id, number: 1, kind: "INITIAL", assignedSellerId: ownerId, teamId, startedBy: actor.userId })
        .returning({ id: leadCycles.id });
      await recordLeadEvents(tx, [
        {
          leadId: lead.id,
          cycleId: cycle.id,
          type: "CREATED",
          actorId: actor.userId,
          stage: "NEW",
          ownerId,
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
    await runTransaction(db, async (tx) => {
      const lead = await lockLeadForChange(tx, actor, id);
      if (lead.status === "TRASHED") throw new ValidationError("Lead na Lixeira não pode ser editado. Recupere-o primeiro.");
      assertSellerMayChange(actor, lead);

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

  await runTransaction(db, async (tx) => {
    const lead = await lockLeadForChange(tx, actor, id);
    assertSellerMayChange(actor, lead);
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
// Movimentação de etapa (Kanban) — vendedor responsável
// ---------------------------------------------------------------------------

/**
 * Move o lead para outra etapa, validando no backend, nesta ordem: permissão
 * e escopo (lead próprio e ativo), negociação vencida em OUTRO lead, transição
 * permitida (STAGE_TRANSITIONS) e Follow-up 3 vencido. Define a entrada na
 * etapa e o prazo (24 h corridas nas etapas com prazo; nenhum nas demais) e
 * grava STAGE_CHANGED, tudo na mesma transação.
 */
export async function moveLeadStage({ db, actor }: ServiceContext, rawId: unknown, input: unknown): Promise<LeadView> {
  assertPermission(actor, "leads:move");
  const id = parseInput(idSchema, rawId);
  const { toStage } = parseInput(moveStageSchema, input);

  await runTransaction(db, async (tx) => {
    const lead = await lockLeadForChange(tx, actor, id);
    // A própria negociação vencida pode ser movida; as outras ficam travadas.
    await assertNoOverdueNegotiation(tx, actor, lead.id);

    if (toStage === lead.stage) throw new ValidationError(`O lead já está em ${STAGE_LABELS[toStage]}.`);
    if (toStage === "CLOSED") {
      throw new ValidationError("Fechamento só acontece ao registrar uma venda.");
    }
    if (toStage === "REWORK") {
      throw new ValidationError("Retrabalho só acontece por redistribuição ou recuperação da Lixeira, feitas pelo supervisor.");
    }
    if (!canTransition(lead.stage, toStage)) {
      throw new ValidationError(`Movimentação não permitida: de ${STAGE_LABELS[lead.stage]} para ${STAGE_LABELS[toStage]}.`);
    }
    assertSellerMayChange(actor, lead);

    const hours = toStage === "NEGOTIATION" ? BUSINESS_RULES.negotiationDeadlineHours : BUSINESS_RULES.followUpDeadlineHours;
    await tx
      .update(leads)
      .set({
        stage: toStage,
        stageEnteredAt: sql`now()`,
        stageDueAt: STAGES_WITH_DEADLINE.includes(toStage) ? sql`now() + make_interval(hours => ${hours})` : null,
      })
      .where(eq(leads.id, lead.id));

    const cycle = await currentCycle(tx, lead.id);
    await recordLeadEvents(tx, [
      {
        leadId: lead.id,
        cycleId: cycle.id,
        type: "STAGE_CHANGED",
        actorId: actor.userId,
        stage: toStage,
        fromStage: lead.stage,
        ownerId: lead.ownerId,
        teamId: lead.teamId,
        supervisorId: await supervisorOf(tx, lead.teamId),
      },
    ]);
  });
  return (await findLeadView(db, actor, id))!;
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

  await runTransaction(db, async (tx) => {
    const lead = await lockLeadForChange(tx, actor, id, [toSellerId]);
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

  await runTransaction(db, async (tx) => {
    const lead = await lockLeadForChange(tx, actor, id, [toSellerId]);
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

  await runTransaction(db, async (tx) => {
    const lead = await lockLeadForChange(tx, actor, id);
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

  await runTransaction(db, async (tx) => {
    const lead = await lockLeadForChange(tx, actor, id, [toSellerId]);
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

// ---------------------------------------------------------------------------
// Integração com Vendas (uso interno do módulo de vendas)
// ---------------------------------------------------------------------------
// Chamadas dentro da transação da operação de venda, com o lead travado
// (lockLeadForChange/lockLeadForSale) e DEPOIS de gravar a venda
// (lead_events.sale_id referencia a venda do mesmo lead). Não fazem checagem
// de permissão: quem chama já fez.

export type SaleLeadEvent = "SALE_CREATED" | "SALE_REACTIVATED" | "SALE_SELLER_CHANGED";

/**
 * Venda válida (nova, reativada ou com novo responsável) no lead:
 *   - lead ainda não fechado (só em criação/reativação): encerra o ciclo
 *     aberto (WON) e vai para Fechamento, sem prazo, preservando o histórico;
 *   - lead já em Fechamento: continua em Fechamento, no mesmo ciclo;
 *   - o responsável passa a ser o vendedor da venda, na equipe atual dele
 *     (sai da fila, se estava sem responsável);
 *   - grava o evento (retrato depois do fato, com de → para do que mudou).
 *     Troca de responsável que não muda nada no lead não gera evento.
 */
export async function applySaleToLead(
  tx: Database,
  actor: Actor,
  lead: LockedLead,
  seller: { id: string; teamId: string },
  saleId: string,
  type: SaleLeadEvent,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const closing = lead.stage !== "CLOSED";
  const ownerChanged = lead.ownerId !== seller.id;
  const teamChanged = lead.teamId !== seller.teamId;
  if (type === "SALE_SELLER_CHANGED" && !closing && !ownerChanged && !teamChanged) return;

  let cycleId: string;
  if (closing) {
    const cycle = await currentCycle(tx, lead.id);
    await tx
      .update(leadCycles)
      .set({ endedAt: sql`now()`, endedBy: actor.userId, endReason: "WON" })
      .where(eq(leadCycles.id, cycle.id));
    cycleId = cycle.id;
  } else {
    cycleId = (await latestCycle(tx, lead.id)).id;
  }

  if (closing || ownerChanged || teamChanged) {
    await tx
      .update(leads)
      .set({
        ...(closing ? { stage: "CLOSED" as const, stageEnteredAt: sql`now()`, stageDueAt: null } : {}),
        ownerId: seller.id,
        teamId: seller.teamId,
        unassignedAt: null,
        unassignedReason: null,
      })
      .where(eq(leads.id, lead.id));
  }

  const [fromSupervisorId, supervisorId] = await Promise.all([supervisorOf(tx, lead.teamId), supervisorOf(tx, seller.teamId)]);
  await recordLeadEvents(tx, [
    {
      leadId: lead.id,
      cycleId,
      type,
      actorId: actor.userId,
      stage: "CLOSED",
      fromStage: closing ? lead.stage : null,
      ownerId: seller.id,
      fromOwnerId: ownerChanged ? lead.ownerId : null,
      teamId: seller.teamId,
      fromTeamId: teamChanged ? lead.teamId : null,
      supervisorId,
      fromSupervisorId: teamChanged ? fromSupervisorId : null,
      saleId,
      metadata,
    },
  ]);
}

/** O que o estorno de uma venda faz com o lead (decidido ANTES de gravar). */
export type SaleReversalPlan =
  /** Ainda há outra venda válida: o lead continua em Fechamento com o mesmo responsável. */
  | { kind: "KEEP_CLOSED" }
  /** Última venda válida, responsável ativo e elegível: novo ciclo REOPENED com ele. */
  | { kind: "REOPEN"; ownerId: string }
  /** Última venda válida, responsável inativo: novo ciclo REOPENED, lead na fila do supervisor. */
  | { kind: "REOPEN_TO_QUEUE"; previousOwnerId: string };

/** Estorno da última venda sem regra definida para o responsável atual (não é improvisado). */
export const REVERSAL_NEEDS_VALID_OWNER =
  "Para estornar a última venda válida, o responsável atual do lead precisa ser um vendedor ativo da equipe do lead " +
  "(ou estar inativo, com a equipe do lead ativa). Troque o responsável da venda por um vendedor ativo de equipe ativa e tente novamente.";

/**
 * Decide o efeito do estorno no lead (lead em Fechamento, travado, assim como
 * o responsável e as equipes dele). Última venda válida:
 *   - responsável SELLER ativo, da mesma equipe do lead, com equipe ativa →
 *     reabre com ele;
 *   - responsável inativo e equipe do lead ativa → reabre na fila do
 *     supervisor (mesmo tratamento da desativação de vendedor, C12);
 *   - qualquer outro caso (responsável ativo em outra equipe ou em equipe
 *     inativa; equipe do lead inativa) → recusado: não há regra confirmada.
 */
export async function planSaleReversal(tx: Database, lead: LockedLead, otherActiveSales: number): Promise<SaleReversalPlan> {
  if (otherActiveSales > 0) return { kind: "KEEP_CLOSED" };
  const ownerId = lead.ownerId!; // lead em Fechamento sempre tem responsável (CHECK leads_closed_has_owner)
  const [owner] = await tx
    .select({ role: users.role, active: users.active, teamId: users.teamId })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  const [leadTeam] = await tx.select({ active: teams.active }).from(teams).where(eq(teams.id, lead.teamId)).limit(1);
  if (!leadTeam?.active) throw new ConflictError(REVERSAL_NEEDS_VALID_OWNER);
  if (owner?.role === "SELLER" && owner.active && owner.teamId === lead.teamId) return { kind: "REOPEN", ownerId };
  if (owner && !owner.active) return { kind: "REOPEN_TO_QUEUE", previousOwnerId: ownerId };
  throw new ConflictError(REVERSAL_NEEDS_VALID_OWNER);
}

/**
 * Estorno no lead, conforme o plano:
 *   - KEEP_CLOSED: só o evento SALE_REVERSED (mesmo ciclo, mesma etapa);
 *   - REOPEN / REOPEN_TO_QUEUE: novo ciclo REOPENED (número seguinte,
 *     atribuído ao responsável), lead em Lead cadastrado sem prazo e evento
 *     SALE_REVERSED no ciclo novo. Na fila, o lead fica sem responsável
 *     (OWNER_DEACTIVATED) e um evento UNASSIGNED registra isso — o banco exige
 *     responsável preenchido em eventos SALE_* (lead_events_sale_has_owner).
 */
export async function applySaleReversalToLead(
  tx: Database,
  actor: Actor,
  lead: LockedLead,
  saleId: string,
  plan: SaleReversalPlan,
): Promise<void> {
  const supervisorId = await supervisorOf(tx, lead.teamId);
  const base = { leadId: lead.id, actorId: actor.userId, teamId: lead.teamId, supervisorId };

  if (plan.kind === "KEEP_CLOSED") {
    const cycle = await latestCycle(tx, lead.id);
    await recordLeadEvents(tx, [{ ...base, cycleId: cycle.id, type: "SALE_REVERSED", stage: "CLOSED", ownerId: lead.ownerId, saleId }]);
    return;
  }

  const ownerId = plan.kind === "REOPEN" ? plan.ownerId : plan.previousOwnerId;
  const last = await latestCycle(tx, lead.id);
  const [cycle] = await tx
    .insert(leadCycles)
    .values({ leadId: lead.id, number: last.number + 1, kind: "REOPENED", assignedSellerId: ownerId, teamId: lead.teamId, startedBy: actor.userId })
    .returning({ id: leadCycles.id });
  const toQueue = plan.kind === "REOPEN_TO_QUEUE";
  await tx
    .update(leads)
    .set({
      stage: "NEW",
      stageEnteredAt: sql`now()`,
      stageDueAt: null,
      ...(toQueue ? { ownerId: null, unassignedAt: sql`now()`, unassignedReason: "OWNER_DEACTIVATED" as const } : {}),
    })
    .where(eq(leads.id, lead.id));

  const events: LeadEventInput[] = [
    { ...base, cycleId: cycle.id, type: "SALE_REVERSED", stage: "NEW", fromStage: "CLOSED", ownerId, saleId },
  ];
  if (toQueue) {
    events.push({
      ...base,
      cycleId: cycle.id,
      type: "UNASSIGNED",
      stage: "NEW",
      ownerId: null,
      fromOwnerId: ownerId,
      unassignedReason: "OWNER_DEACTIVATED",
      metadata: { afterSaleReversal: true },
    });
  }
  await recordLeadEvents(tx, events);
}

