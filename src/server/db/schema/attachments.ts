import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { SaleAttachmentType } from "../../../lib/sale-attachments";
import { users } from "./organization";
import { sales } from "./sales";

export type { SaleAttachmentType };

/**
 * Comprovantes de pagamento da venda. Espelha database/migrations/
 * 007_sale_attachments.sql, que é a fonte do schema. Ficam SÓ no SQL os
 * triggers (sem DELETE/TRUNCATE; dados do envio imutáveis; remoção lógica
 * uma única vez).
 *
 * O arquivo fica no Cloudflare R2 (`storage_key`); aqui ficam só os dados do
 * anexo. Vários por venda, todos opcionais.
 */
export const saleAttachments = pgTable(
  "sale_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "restrict" }),
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").$type<SaleAttachmentType>().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    unique("sale_attachments_storage_key_unique").on(t.storageKey),
    index("sale_attachments_sale_idx").on(t.saleId, t.createdAt),
    check("sale_attachments_storage_key_present", sql`btrim(${t.storageKey}) <> '' AND char_length(${t.storageKey}) <= 300`),
    check("sale_attachments_file_name_present", sql`btrim(${t.fileName}) <> '' AND char_length(${t.fileName}) <= 255`),
    check(
      "sale_attachments_content_type_allowed",
      sql`${t.contentType} IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')`,
    ),
    check("sale_attachments_size_range", sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 5242880`),
    check("sale_attachments_removed_pair", sql`(${t.removedAt} IS NULL) = (${t.removedBy} IS NULL)`),
  ],
);
