import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./organization";
import { saleItems } from "./sales";

/**
 * Certificados (Documento Mestre §18). Espelha database/migrations/
 * 005_certificates.sql, que é a fonte do schema. Ficam SÓ no SQL os triggers
 * (sem DELETE/TRUNCATE; item, autor e data de registro imutáveis).
 *
 * Um certificado por ITEM de venda (o mesmo curso repetido na venda são itens
 * distintos). Aluno, curso, vendedor e data da venda vêm do item, da venda e
 * do lead; aqui ficam só conclusão, entrega e certificadora (texto livre).
 * Datas "AAAA-MM-DD", no fuso do negócio.
 */
export const certificates = pgTable(
  "certificates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleItemId: uuid("sale_item_id")
      .notNull()
      .references(() => saleItems.id, { onDelete: "restrict" }),
    completedOn: date("completed_on", { mode: "string" }).notNull(),
    deliveredOn: date("delivered_on", { mode: "string" }).notNull(),
    certifier: text("certifier").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("certificates_sale_item_unique").on(t.saleItemId),
    index("certificates_completed_on_idx").on(t.completedOn),
    index("certificates_delivered_on_idx").on(t.deliveredOn),
    check("certificates_certifier_present", sql`btrim(${t.certifier}) <> '' AND char_length(${t.certifier}) <= 200`),
    check("certificates_delivered_after_completed", sql`${t.deliveredOn} >= ${t.completedOn}`),
  ],
);
