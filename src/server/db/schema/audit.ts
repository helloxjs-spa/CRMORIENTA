import { sql } from "drizzle-orm";
import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { teams, users } from "./organization";

/**
 * Log central de auditoria, append-only (UPDATE/DELETE bloqueados por trigger
 * na migration 0001). Registra eventos administrativos, de segurança e
 * financeiros. A linha do tempo comercial do lead terá tabela própria
 * (lead_events) na fase de Leads — ver docs/ARQUITETURA.md, seção Auditoria.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    /** Equipe afetada, para permitir que supervisores consultem a auditoria do próprio time. */
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "restrict" }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
    index("audit_events_actor_idx").on(t.actorId),
    index("audit_events_occurred_idx").on(t.occurredAt),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
