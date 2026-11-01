import { randomUUID } from "node:crypto";
import { and, asc, count, eq, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Actor } from "@/server/authz/actor";
import { assertPermission } from "@/server/authz/permissions";
import { ownedScope } from "@/server/authz/scope";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { ServiceContext } from "@/server/context";
import { saleAttachments, sales, users, type SaleAttachmentType } from "@/server/db/schema";
import { runTransaction } from "@/server/db/transaction";
import { NotFoundError, ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import type { FileStorage } from "@/server/storage/file-storage";
import { idSchema, parseInput } from "@/server/validation";

/**
 * Comprovantes de pagamento da venda (007). Opcionais e vários por venda
 * (decisão do usuário em 31/10/2026).
 *
 * - Escopo (C50), o mesmo das vendas: SELLER as vendas de que é responsável;
 *   SUPERVISOR as dos vendedores atualmente na equipe que lidera; ADMIN todas.
 * - O tipo é conferido pelo CONTEÚDO do arquivo (assinatura), nunca pelo nome
 *   ou pelo tipo informado pelo navegador.
 * - O arquivo vai primeiro para o armazenamento (R2) e depois o registro e a
 *   auditoria entram numa transação; se a transação falhar, o arquivo enviado
 *   é apagado do armazenamento (nunca chegou a ficar visível).
 * - Remoção só LÓGICA (removed_at/removed_by, uma vez; o banco garante): o
 *   comprovante some da lista e não abre mais, mas o registro e o arquivo no
 *   R2 ficam guardados. Quem pode anexar pode remover, no mesmo escopo.
 */

export const MAX_FILES_PER_UPLOAD = 10;
export const TOO_MANY_ATTACHMENTS = `Esta venda já tem o máximo de ${BUSINESS_RULES.saleAttachmentMaxPerSale} comprovantes.`;
export const UNSUPPORTED_FILE = "Envie uma imagem (JPG, PNG ou WEBP) ou um PDF.";
const maxMb = BUSINESS_RULES.saleAttachmentMaxBytes / (1024 * 1024);

export type SaleAttachmentView = {
  id: string;
  fileName: string;
  contentType: SaleAttachmentType;
  sizeBytes: number;
  createdAt: Date;
  uploadedByName: string;
};

const responsible = alias(users, "attachment_sale_seller");
const uploader = alias(users, "attachment_uploader");

function saleScope(actor: Actor): SQL | undefined {
  return ownedScope(actor, { ownerId: sales.sellerId, teamId: responsible.teamId });
}

/** Tipo pelo conteúdo (assinatura do arquivo); null se não for um tipo aceito. */
export function detectAttachmentType(bytes: Uint8Array): SaleAttachmentType | null {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  const ascii = (offset: number, text: string) => [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "%PDF-")) return "application/pdf";
  return null;
}

/** Nome exibido: sem caminho nem caracteres de controle, até 255 caracteres. */
function cleanFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "comprovante").slice(0, 255);
}

const fileSchema = z.strictObject({
  fileName: z.string().max(1000),
  bytes: z
    .instanceof(Uint8Array, { error: "Arquivo inválido." })
    .refine((bytes) => bytes.length > 0, "O arquivo está vazio.")
    .refine((bytes) => bytes.length <= BUSINESS_RULES.saleAttachmentMaxBytes, `Cada arquivo pode ter no máximo ${maxMb} MB.`),
});

const uploadSchema = z.strictObject({
  files: z
    .array(fileSchema)
    .min(1, "Selecione pelo menos um arquivo.")
    .max(MAX_FILES_PER_UPLOAD, `Envie no máximo ${MAX_FILES_PER_UPLOAD} arquivos por vez.`),
});

/** Anexa comprovantes a uma venda no escopo do ator. */
export async function addSaleAttachments(
  { db, actor }: ServiceContext,
  storage: FileStorage,
  rawSaleId: unknown,
  input: unknown,
): Promise<{ attachmentIds: string[] }> {
  assertPermission(actor, "sales:attachReceipt");
  const saleId = parseInput(idSchema, rawSaleId);
  const { files } = parseInput(uploadSchema, input);

  const prepared = files.map((file) => {
    const contentType = detectAttachmentType(file.bytes);
    if (!contentType) throw new ValidationError(UNSUPPORTED_FILE, { files: [`${cleanFileName(file.fileName)}: ${UNSUPPORTED_FILE}`] });
    return { ...file, fileName: cleanFileName(file.fileName), contentType, storageKey: `sales/${saleId}/${randomUUID()}` };
  });

  // Fora do escopo: 404 antes de enviar qualquer arquivo.
  const [visible] = await db
    .select({ id: sales.id })
    .from(sales)
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .where(and(eq(sales.id, saleId), saleScope(actor)))
    .limit(1);
  if (!visible) throw new NotFoundError();

  const uploaded: string[] = [];
  try {
    for (const file of prepared) {
      await storage.put(file.storageKey, file.bytes, file.contentType);
      uploaded.push(file.storageKey);
    }
    return await runTransaction(db, async (tx) => {
      const [sale] = await tx
        .select({ id: sales.id, sellerTeamId: responsible.teamId })
        .from(sales)
        .innerJoin(responsible, eq(responsible.id, sales.sellerId))
        .where(and(eq(sales.id, saleId), saleScope(actor)))
        .for("share", { of: sales });
      if (!sale) throw new NotFoundError();

      const [{ active }] = await tx
        .select({ active: count() })
        .from(saleAttachments)
        .where(and(eq(saleAttachments.saleId, saleId), isNull(saleAttachments.removedAt)));
      if (active + prepared.length > BUSINESS_RULES.saleAttachmentMaxPerSale) throw new ValidationError(TOO_MANY_ATTACHMENTS);

      const attachmentIds: string[] = [];
      for (const file of prepared) {
        const [created] = await tx
          .insert(saleAttachments)
          .values({
            saleId,
            storageKey: file.storageKey,
            fileName: file.fileName,
            contentType: file.contentType,
            sizeBytes: file.bytes.length,
            uploadedBy: actor.userId,
          })
          .returning({ id: saleAttachments.id });
        await recordAudit(tx, {
          actorId: actor.userId,
          action: "sale_attachment.created",
          entityType: "sale_attachment",
          entityId: created.id,
          teamId: sale.sellerTeamId,
          metadata: { saleId, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.bytes.length },
        });
        attachmentIds.push(created.id);
      }
      return { attachmentIds };
    });
  } catch (error) {
    await Promise.allSettled(uploaded.map((key) => storage.delete(key)));
    throw error;
  }
}

/** Comprovantes ativos da venda, do mais antigo para o mais novo (mesmo envio: por nome). */
export async function listSaleAttachments({ db, actor }: ServiceContext, rawSaleId: unknown): Promise<SaleAttachmentView[]> {
  assertPermission(actor, "sales:view");
  const saleId = parseInput(idSchema, rawSaleId);
  return db
    .select({
      id: saleAttachments.id,
      fileName: saleAttachments.fileName,
      contentType: saleAttachments.contentType,
      sizeBytes: saleAttachments.sizeBytes,
      createdAt: saleAttachments.createdAt,
      uploadedByName: uploader.name,
    })
    .from(saleAttachments)
    .innerJoin(sales, eq(sales.id, saleAttachments.saleId))
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .innerJoin(uploader, eq(uploader.id, saleAttachments.uploadedBy))
    .where(and(eq(saleAttachments.saleId, saleId), isNull(saleAttachments.removedAt), saleScope(actor)))
    .orderBy(asc(saleAttachments.createdAt), asc(saleAttachments.fileName), asc(saleAttachments.id));
}

/** Conteúdo de um comprovante da venda, no escopo do ator (404 fora dele). */
export async function getSaleAttachmentFile(
  { db, actor }: ServiceContext,
  storage: FileStorage,
  rawSaleId: unknown,
  rawAttachmentId: unknown,
): Promise<{ fileName: string; contentType: SaleAttachmentType; bytes: Uint8Array }> {
  assertPermission(actor, "sales:view");
  const saleId = parseInput(idSchema, rawSaleId);
  const attachmentId = parseInput(idSchema, rawAttachmentId);
  const [attachment] = await db
    .select({ storageKey: saleAttachments.storageKey, fileName: saleAttachments.fileName, contentType: saleAttachments.contentType })
    .from(saleAttachments)
    .innerJoin(sales, eq(sales.id, saleAttachments.saleId))
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .where(and(eq(saleAttachments.id, attachmentId), eq(saleAttachments.saleId, saleId), isNull(saleAttachments.removedAt), saleScope(actor)))
    .limit(1);
  if (!attachment) throw new NotFoundError();
  const stored = await storage.get(attachment.storageKey);
  if (!stored) throw new NotFoundError();
  return { fileName: attachment.fileName, contentType: attachment.contentType, bytes: stored.bytes };
}

/** Remove (logicamente) um comprovante da venda, no escopo do ator (404 fora dele ou se já removido). */
export async function removeSaleAttachment({ db, actor }: ServiceContext, rawSaleId: unknown, rawAttachmentId: unknown): Promise<void> {
  assertPermission(actor, "sales:attachReceipt");
  const saleId = parseInput(idSchema, rawSaleId);
  const attachmentId = parseInput(idSchema, rawAttachmentId);

  await runTransaction(db, async (tx) => {
    const [attachment] = await tx
      .select({ id: saleAttachments.id, fileName: saleAttachments.fileName, sellerTeamId: responsible.teamId })
      .from(saleAttachments)
      .innerJoin(sales, eq(sales.id, saleAttachments.saleId))
      .innerJoin(responsible, eq(responsible.id, sales.sellerId))
      .where(and(eq(saleAttachments.id, attachmentId), eq(saleAttachments.saleId, saleId), isNull(saleAttachments.removedAt), saleScope(actor)))
      .for("update", { of: saleAttachments });
    if (!attachment) throw new NotFoundError();

    await tx.update(saleAttachments).set({ removedAt: sql`now()`, removedBy: actor.userId }).where(eq(saleAttachments.id, attachment.id));
    await recordAudit(tx, {
      actorId: actor.userId,
      action: "sale_attachment.removed",
      entityType: "sale_attachment",
      entityId: attachment.id,
      teamId: attachment.sellerTeamId,
      metadata: { saleId, fileName: attachment.fileName },
    });
  });
}
