import { sql } from "drizzle-orm";
import { check, date, index, integer, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./organization";
import { sales } from "./sales";

/**
 * Parcelas do cartão (Documento Mestre §12; C52). Espelha database/migrations/
 * 006_installments.sql, que é a fonte do schema. Ficam SÓ no SQL os triggers:
 * transições de situação, imutabilidade, carimbos de tempo, sem DELETE e a
 * conferência do cronograma atual de cada venda no COMMIT.
 *
 * Cronograma atual = `replacedAt` NULL. Colunas "do banco" são carimbadas pelos
 * triggers (a aplicação só sinaliza a transição).
 */

export const INSTALLMENT_STATUSES = ["OPEN", "PAID", "CANCELED"] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];

export const installmentStatus = pgEnum("installment_status", INSTALLMENT_STATUSES);

export const installments = pgTable(
  "installments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    amountCents: integer("amount_cents").notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    status: installmentStatus("status").notNull().default("OPEN"),
    /** Do banco (na transição para PAID). */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidBy: uuid("paid_by").references(() => users.id, { onDelete: "restrict" }),
    /** Do banco: cronograma substituído (histórico). */
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
    /** Do banco. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("installments_current_number_unique").on(t.saleId, t.number).where(sql`replaced_at IS NULL`),
    index("installments_sale_idx").on(t.saleId),
    index("installments_due_date_idx").on(t.dueDate),
    check("installments_number_positive", sql`${t.number} >= 1`),
    check("installments_amount_positive", sql`${t.amountCents} > 0`),
    check(
      "installments_paid_consistent",
      sql`(${t.status} = 'PAID') = (${t.paidAt} IS NOT NULL) AND (${t.paidAt} IS NULL) = (${t.paidBy} IS NULL)`,
    ),
    check("installments_replaced_canceled", sql`${t.replacedAt} IS NULL OR ${t.status} = 'CANCELED'`),
  ],
);
