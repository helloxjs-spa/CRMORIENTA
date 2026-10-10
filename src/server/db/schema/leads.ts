import { sql } from "drizzle-orm";
import { bigserial, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { teams, users } from "./organization";

/**
 * Módulo de Leads. Espelha database/migrations/002_leads.sql, que é a fonte
 * do schema: CHECKs, FKs compostas e triggers de integridade (responsável
 * SELLER ativo da mesma equipe, coerência lead x ciclos, append-only, sem
 * exclusão física) existem só no SQL.
 */

export const LEAD_STAGES = [
  "NEW",
  "NO_ANSWER",
  "FOLLOW_UP_1",
  "FOLLOW_UP_2",
  "FOLLOW_UP_3",
  "NEGOTIATION",
  "CLOSED",
  "REWORK",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_STATUSES = ["ACTIVE", "TRASHED"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_UNASSIGNED_REASONS = ["OWNER_DEACTIVATED"] as const;
export type LeadUnassignedReason = (typeof LEAD_UNASSIGNED_REASONS)[number];

export const LEAD_CYCLE_KINDS = ["INITIAL", "REWORK"] as const;
export type LeadCycleKind = (typeof LEAD_CYCLE_KINDS)[number];

export const LEAD_CYCLE_END_REASONS = ["REDISTRIBUTED", "TRASHED", "WON"] as const;
export type LeadCycleEndReason = (typeof LEAD_CYCLE_END_REASONS)[number];

export const LEAD_EVENT_TYPES = [
  "CREATED",
  "DETAILS_UPDATED",
  "STAGE_CHANGED",
  "TRANSFERRED",
  "TEAM_CHANGED",
  "UNASSIGNED",
  "REDISTRIBUTED",
  "TRASHED",
  "RESTORED",
  "NOTE_ADDED",
] as const;
export type LeadEventType = (typeof LEAD_EVENT_TYPES)[number];

export const leadStage = pgEnum("lead_stage", LEAD_STAGES);
export const leadStatus = pgEnum("lead_status", LEAD_STATUSES);
export const leadUnassignedReason = pgEnum("lead_unassigned_reason", LEAD_UNASSIGNED_REASONS);
export const leadCycleKind = pgEnum("lead_cycle_kind", LEAD_CYCLE_KINDS);
export const leadCycleEndReason = pgEnum("lead_cycle_end_reason", LEAD_CYCLE_END_REASONS);
export const leadEventType = pgEnum("lead_event_type", LEAD_EVENT_TYPES);

/**
 * Lead. `phone` é canônico (só dígitos, 55 + DDD + número) e único para
 * sempre, inclusive na Lixeira. `ownerId` NULL = aguardando decisão do
 * supervisor da equipe `teamId` (fila), com `unassignedAt/unassignedReason`.
 * `createdAt` é a data de cadastro.
 */
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    interestCourseId: uuid("interest_course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "restrict" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
    unassignedReason: leadUnassignedReason("unassigned_reason"),
    stage: leadStage("stage").notNull().default("NEW"),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
    stageDueAt: timestamp("stage_due_at", { withTimezone: true }),
    status: leadStatus("status").notNull().default("ACTIVE"),
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    trashedBy: uuid("trashed_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("leads_phone_unique").on(t.phone),
    index("leads_owner_status_stage_idx").on(t.ownerId, t.status, t.stage),
    index("leads_team_status_stage_idx").on(t.teamId, t.status, t.stage),
    index("leads_created_at_idx").on(t.createdAt),
    index("leads_negotiation_due_idx")
      .on(t.ownerId, t.stageDueAt)
      .where(sql`${t.stage} = 'NEGOTIATION' AND ${t.status} = 'ACTIVE'`),
    index("leads_follow_up_3_due_idx")
      .on(t.teamId, t.stageDueAt)
      .where(sql`${t.stage} = 'FOLLOW_UP_3' AND ${t.status} = 'ACTIVE'`),
    index("leads_unassigned_idx")
      .on(t.teamId, t.unassignedAt)
      .where(sql`${t.ownerId} IS NULL AND ${t.status} = 'ACTIVE'`),
  ],
);

/** Ciclo de atendimento. Ciclo atual = o ciclo aberto (endedAt NULL), no máximo um por lead. */
export const leadCycles = pgTable(
  "lead_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    kind: leadCycleKind("kind").notNull(),
    assignedSellerId: uuid("assigned_seller_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    startedBy: uuid("started_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: uuid("ended_by").references(() => users.id, { onDelete: "restrict" }),
    endReason: leadCycleEndReason("end_reason"),
  },
  (t) => [
    unique("lead_cycles_lead_id_id_unique").on(t.leadId, t.id),
    unique("lead_cycles_lead_number_unique").on(t.leadId, t.number),
    uniqueIndex("lead_cycles_one_open_per_lead").on(t.leadId).where(sql`${t.endedAt} IS NULL`),
    index("lead_cycles_assigned_seller_idx").on(t.assignedSellerId),
  ],
);

/** Observação append-only, com o contexto (ciclo e etapa) em que foi registrada. */
export const leadNotes = pgTable(
  "lead_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").notNull(),
    cycleId: uuid("cycle_id").notNull(),
    stage: leadStage("stage").notNull(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("lead_notes_lead_id_id_unique").on(t.leadId, t.id),
    index("lead_notes_lead_created_idx").on(t.leadId, t.createdAt),
  ],
);

/**
 * Linha do tempo do lead (append-only): retrato DEPOIS do fato (ciclo, etapa,
 * responsável, equipe, supervisor) e o valor anterior em from* quando mudou.
 */
export const leadEvents = pgTable(
  "lead_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    leadId: uuid("lead_id").notNull(),
    cycleId: uuid("cycle_id").notNull(),
    type: leadEventType("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    stage: leadStage("stage").notNull(),
    fromStage: leadStage("from_stage"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "restrict" }),
    fromOwnerId: uuid("from_owner_id").references(() => users.id, { onDelete: "restrict" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    fromTeamId: uuid("from_team_id").references(() => teams.id, { onDelete: "restrict" }),
    supervisorId: uuid("supervisor_id").references(() => users.id, { onDelete: "restrict" }),
    fromSupervisorId: uuid("from_supervisor_id").references(() => users.id, { onDelete: "restrict" }),
    unassignedReason: leadUnassignedReason("unassigned_reason"),
    noteId: uuid("note_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("lead_events_lead_occurred_idx").on(t.leadId, t.occurredAt),
    index("lead_events_team_occurred_idx").on(t.teamId, t.occurredAt),
    index("lead_events_actor_idx").on(t.actorId),
  ],
);

export type Lead = typeof leads.$inferSelect;
export type LeadCycle = typeof leadCycles.$inferSelect;
export type LeadNote = typeof leadNotes.$inferSelect;
export type LeadEvent = typeof leadEvents.$inferSelect;
