import { sql } from "drizzle-orm";
import { check, date, integer, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./organization";

/**
 * Metas mensais de faturamento. Espelha database/migrations/008_sales_goals.sql,
 * que é a fonte do schema. Ficam SÓ no SQL os triggers (sem DELETE/TRUNCATE;
 * meta individual só para SELLER; mês, vendedor e criação imutáveis).
 *
 * Por mês ("AAAA-MM-01"): uma meta geral (seller_id NULL) e uma por vendedor.
 * amount_cents NULL = meta retirada (exibida como "Sem meta definida").
 */
export const salesGoals = pgTable(
  "sales_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    month: date("month", { mode: "string" }).notNull(),
    sellerId: uuid("seller_id").references(() => users.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sales_goals_general_month_unique").on(t.month).where(sql`${t.sellerId} IS NULL`),
    uniqueIndex("sales_goals_seller_month_unique").on(t.month, t.sellerId).where(sql`${t.sellerId} IS NOT NULL`),
    check("sales_goals_month_first_day", sql`EXTRACT(DAY FROM ${t.month}) = 1`),
    check("sales_goals_amount_positive", sql`${t.amountCents} IS NULL OR ${t.amountCents} > 0`),
  ],
);
