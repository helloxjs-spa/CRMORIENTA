import { sql } from "drizzle-orm";
import { bigint, bigserial, check, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { leads } from "./leads";
import { teams, users } from "./organization";

/**
 * Módulo de Vendas. Espelha database/migrations/003_sales.sql e
 * 004_sale_item_prices.sql, que são a fonte do schema. Ficam SÓ no SQL: os triggers (imutáveis, snapshots conferidos,
 * carimbos de tempo, tx_base/txid, metadata dos eventos, checagens no COMMIT,
 * exigência de READ COMMITTED) e a FK composta lead_events (lead_id, sale_id)
 * → sales (lead_id, id).
 *
 * Colunas marcadas "do banco" são preenchidas/sobrescritas pelos triggers:
 * a aplicação não as grava e o ORM não tem default/onUpdate próprio para elas.
 */

export const SALE_STATUSES = ["ACTIVE", "REVERSED"] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const PAYMENT_METHODS = ["PIX", "CARD"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SALE_EVENT_TYPES = ["CREATED", "UPDATED", "REVERSED", "REACTIVATED"] as const;
export type SaleEventType = (typeof SALE_EVENT_TYPES)[number];

export const saleStatus = pgEnum("sale_status", SALE_STATUSES);
export const paymentMethod = pgEnum("payment_method", PAYMENT_METHODS);
export const saleEventType = pgEnum("sale_event_type", SALE_EVENT_TYPES);

/**
 * Venda de um lead. `teamId` = equipe do vendedor responsável quando ele
 * passou a ser o responsável (atribuição de faturamento/ranking por equipe);
 * `supervisorId` = supervisor dessa equipe naquele momento (histórico).
 * `saleDate` = data comercial, no fuso do negócio (string "AAAA-MM-DD").
 */
export const sales = pgTable(
  "sales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "restrict" }),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    supervisorId: uuid("supervisor_id").references(() => users.id, { onDelete: "restrict" }),
    saleDate: date("sale_date", { mode: "string" }).notNull(),
    totalCents: integer("total_cents").notNull(),
    paymentMethod: paymentMethod("payment_method").notNull(),
    installmentCount: integer("installment_count"),
    status: saleStatus("status").notNull().default("ACTIVE"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Do banco. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Do banco (carimbado a cada alteração da venda ou dos itens). */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Do banco: controle técnico da auditoria. Não usar em regra de negócio. */
    lastChangeTxid: bigint("last_change_txid", { mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
    /** Do banco: estado comercial no início da transação que alterou a venda. */
    txBase: jsonb("tx_base").$type<Record<string, unknown>>(),
  },
  (t) => [
    unique("sales_lead_id_id_unique").on(t.leadId, t.id),
    index("sales_lead_idx").on(t.leadId),
    index("sales_seller_status_date_idx").on(t.sellerId, t.status, t.saleDate),
    index("sales_team_status_date_idx").on(t.teamId, t.status, t.saleDate),
    index("sales_status_date_idx").on(t.status, t.saleDate),
    check("sales_total_positive", sql`${t.totalCents} > 0`),
    check(
      "sales_installments_consistent",
      sql`(${t.paymentMethod} = 'PIX' AND ${t.installmentCount} IS NULL)
        OR (${t.paymentMethod} = 'CARD' AND ${t.installmentCount} IS NOT NULL AND ${t.installmentCount} >= 1)`,
    ),
  ],
);

/**
 * Item = UMA ocorrência de curso vendido (o mesmo curso pode repetir na mesma
 * venda: sem unicidade venda × curso). Nunca é apagado; a única mudança é a
 * remoção lógica. Itens atuais = removedAt NULL.
 */
export const saleItems = pgTable(
  "sale_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "restrict" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    /** Preço de venda desta ocorrência do curso (004). total da venda = soma dos itens atuais. */
    priceCents: integer("price_cents").notNull(),
    /** Custo da bolsa vigente na inclusão (restrito: `courses:viewCost`). */
    costSnapshotCents: integer("cost_snapshot_cents").notNull(),
    commissionSnapshotCents: integer("commission_snapshot_cents").notNull(),
    /** Do banco. */
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Do banco (a aplicação só sinaliza a remoção junto com removedBy). */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by").references(() => users.id, { onDelete: "restrict" }),
    /** Do banco: controle técnico da auditoria. */
    addedTxid: bigint("added_txid", { mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
    /** Do banco: controle técnico da auditoria. */
    removedTxid: bigint("removed_txid", { mode: "number" }),
    /** Do banco (004): transação da última correção de preço e o preço no início dela. */
    priceChangedTxid: bigint("price_changed_txid", { mode: "number" }),
    priceTxBase: integer("price_tx_base"),
  },
  (t) => [
    index("sale_items_sale_idx").on(t.saleId),
    check("sale_items_price_positive", sql`${t.priceCents} > 0`),
    check("sale_items_price_change_consistent", sql`(${t.priceChangedTxid} IS NULL) = (${t.priceTxBase} IS NULL)`),
    check("sale_items_cost_non_negative", sql`${t.costSnapshotCents} >= 0`),
    check("sale_items_commission_non_negative", sql`${t.commissionSnapshotCents} >= 0`),
    check(
      "sale_items_removal_consistent",
      sql`(${t.removedAt} IS NULL AND ${t.removedBy} IS NULL AND ${t.removedTxid} IS NULL)
        OR (${t.removedAt} IS NOT NULL AND ${t.removedBy} IS NOT NULL AND ${t.removedTxid} IS NOT NULL AND ${t.removedAt} >= ${t.addedAt})`,
    ),
  ],
);

/**
 * Histórico da venda (append-only). A aplicação escolhe só tipo, ator e
 * motivo; occurredAt, txid e metadata são calculados pelo banco. O metadata
 * inclui snapshots de custo dos itens: nunca expô-lo a quem não tem
 * `courses:viewCost`.
 */
export const saleEvents = pgTable(
  "sale_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "restrict" }),
    type: saleEventType("type").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Do banco. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** Do banco. */
    txid: bigint("txid", { mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
    /** Obrigatório em REVERSED e REACTIVATED; ausente nos demais. */
    reason: text("reason"),
    /** Do banco (o valor enviado é ignorado). */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("sale_events_sale_idx").on(t.saleId, t.txid),
    uniqueIndex("sale_events_one_created").on(t.saleId).where(sql`${t.type} = 'CREATED'`),
    uniqueIndex("sale_events_one_update_per_tx").on(t.saleId, t.txid).where(sql`${t.type} = 'UPDATED'`),
    uniqueIndex("sale_events_one_status_change_per_tx")
      .on(t.saleId, t.txid)
      .where(sql`${t.type} IN ('REVERSED', 'REACTIVATED')`),
    check(
      "sale_events_reason_required",
      sql`(${t.type} IN ('REVERSED', 'REACTIVATED')) = (${t.reason} IS NOT NULL)
        AND (${t.reason} IS NULL OR btrim(${t.reason}) <> '')`,
    ),
    check("sale_events_metadata_present", sql`${t.metadata} <> '{}'::jsonb`),
  ],
);

export type Sale = typeof sales.$inferSelect;
export type SaleItem = typeof saleItems.$inferSelect;
export type SaleEvent = typeof saleEvents.$inferSelect;
