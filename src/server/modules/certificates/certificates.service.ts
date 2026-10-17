import { and, count, countDistinct, desc, eq, gte, ilike, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { CERTIFICATE_DATE_FIELDS, CERTIFICATE_PAGE_SIZES, CERTIFIER_MAX_LENGTH } from "@/lib/certificates";
import type { Actor } from "@/server/authz/actor";
import { assertPermission } from "@/server/authz/permissions";
import { ownedScope } from "@/server/authz/scope";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { ServiceContext } from "@/server/context";
import { isUniqueViolation } from "@/server/db/errors";
import { certificates, courses, leads, saleItems, sales, users, type SaleStatus } from "@/server/db/schema";
import { runTransaction } from "@/server/db/transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { idSchema, parseInput } from "@/server/validation";

/**
 * Certificados (Documento Mestre §18): controle operacional, sem arquivo.
 *
 * - Um certificado por ITEM de venda (o banco garante); itens repetidos do
 *   mesmo curso são distintos.
 * - Registro de uma vez (C51): conclusão, entrega e certificadora obrigatórias;
 *   datas não futuras (fuso do negócio) e entrega ≥ conclusão.
 * - Só itens atuais (não removidos) de vendas válidas recebem certificado (C51).
 * - Escopo (C50), o mesmo das vendas: SELLER as vendas de que é responsável;
 *   SUPERVISOR as dos vendedores atualmente na equipe que lidera; ADMIN todas.
 * - Vendedor exibido = responsável ATUAL da venda, lido na hora (C51).
 * - Sem edição nem exclusão (regras ainda não definidas). Estorno da venda ou
 *   remoção do item depois do registro não alteram o certificado (pendente);
 *   a lista mostra a situação atual da venda e do item.
 */

export const CERTIFICATE_EXISTS = "Este curso da venda já tem certificado registrado.";
export const SALE_NOT_VALID = "Só cursos de vendas válidas podem receber certificado.";
export const ITEM_REMOVED = "Este curso foi removido da venda e não pode receber certificado.";

const responsible = alias(users, "certificate_seller");
const registrar = alias(users, "certificate_registrar");

/** Escopo pela venda do item (C50: equipe ATUAL do vendedor responsável). */
function certificateScope(actor: Actor): SQL | undefined {
  return ownedScope(actor, { ownerId: sales.sellerId, teamId: responsible.teamId });
}

/** "Hoje" no fuso único do negócio (AAAA-MM-DD). */
function businessToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(now);
}

const pastDateSchema = (label: string) =>
  z.iso.date({ error: `Informe a ${label}.` }).refine((value) => value <= businessToday(), { message: `A ${label} não pode ser futura.` });

const registerSchema = z
  .strictObject({
    saleItemId: idSchema,
    completedOn: pastDateSchema("data de conclusão"),
    deliveredOn: pastDateSchema("data de entrega"),
    certifier: z
      .string({ error: "Informe a certificadora." })
      .trim()
      .min(1, "Informe a certificadora.")
      .max(CERTIFIER_MAX_LENGTH, `Use no máximo ${CERTIFIER_MAX_LENGTH} caracteres.`),
  })
  .refine((value) => value.deliveredOn >= value.completedOn, {
    path: ["deliveredOn"],
    message: "A entrega não pode ser anterior à conclusão.",
  });

/**
 * Registra o certificado de um item de venda no escopo do ator. A venda é
 * travada (FOR SHARE) antes de conferir a situação: estorno e remoção de item
 * concorrentes (que travam a venda FOR UPDATE) esperam ou são vistos.
 */
export async function registerCertificate(ctx: ServiceContext, input: unknown): Promise<{ certificateId: string }> {
  const { db, actor } = ctx;
  assertPermission(actor, "certificates:operate");
  const data = parseInput(registerSchema, input);

  try {
    return await runTransaction(db, async (tx) => {
      const [item] = await tx
        .select({
          saleId: sales.id,
          saleStatus: sales.status,
          removedAt: saleItems.removedAt,
          courseId: saleItems.courseId,
          sellerTeamId: responsible.teamId,
        })
        .from(saleItems)
        .innerJoin(sales, eq(sales.id, saleItems.saleId))
        .innerJoin(responsible, eq(responsible.id, sales.sellerId))
        .where(and(eq(saleItems.id, data.saleItemId), certificateScope(actor)))
        .for("share", { of: sales });
      if (!item) throw new NotFoundError();
      if (item.saleStatus !== "ACTIVE") throw new ValidationError(SALE_NOT_VALID);
      if (item.removedAt) throw new ValidationError(ITEM_REMOVED);

      const [existing] = await tx.select({ id: certificates.id }).from(certificates).where(eq(certificates.saleItemId, data.saleItemId)).limit(1);
      if (existing) throw new ConflictError(CERTIFICATE_EXISTS);

      const [created] = await tx
        .insert(certificates)
        .values({
          saleItemId: data.saleItemId,
          completedOn: data.completedOn,
          deliveredOn: data.deliveredOn,
          certifier: data.certifier,
          createdBy: actor.userId,
        })
        .returning({ id: certificates.id });
      await recordAudit(tx, {
        actorId: actor.userId,
        action: "certificate.created",
        entityType: "certificate",
        entityId: created.id,
        teamId: item.sellerTeamId,
        metadata: {
          saleId: item.saleId,
          saleItemId: data.saleItemId,
          courseId: item.courseId,
          completedOn: data.completedOn,
          deliveredOn: data.deliveredOn,
          certifier: data.certifier,
        },
      });
      return { certificateId: created.id };
    });
  } catch (error) {
    if (isUniqueViolation(error, "certificates_sale_item_unique")) throw new ConflictError(CERTIFICATE_EXISTS);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const listFiltersSchema = z.strictObject({
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.union(CERTIFICATE_PAGE_SIZES.map((size) => z.literal(size))).optional(),
  /** Nome do aluno (trecho). */
  search: z.string().trim().max(120).optional(),
  /** Data do filtro de período (padrão: entrega). */
  dateField: z.enum(CERTIFICATE_DATE_FIELDS).optional(),
  dateFrom: z.iso.date({ error: "Data inválida." }).optional(),
  dateTo: z.iso.date({ error: "Data inválida." }).optional(),
});

export type CertificateListEntry = {
  id: string;
  studentName: string;
  leadId: string;
  courseName: string;
  institutionName: string;
  /** Responsável ATUAL da venda (C51). */
  sellerName: string;
  saleId: string;
  saleDate: string;
  saleStatus: SaleStatus;
  /** O item foi removido da venda depois do registro (situação atual, só informativa). */
  itemRemoved: boolean;
  completedOn: string;
  deliveredOn: string;
  certifier: string;
  createdByName: string;
  createdAt: Date;
};

export type CertificateList = {
  items: CertificateListEntry[];
  page: number;
  pageSize: number;
  /** Certificados nos filtros. */
  total: number;
  /** Alunos (leads) distintos com certificado nos filtros. */
  students: number;
  totalPages: number;
};

/** Listagem paginada no banco; escopo e filtros no mesmo WHERE, inclusive nas contagens. */
export async function listCertificates({ db, actor }: ServiceContext, rawFilters: unknown = {}): Promise<CertificateList> {
  assertPermission(actor, "certificates:operate");
  const filters = parseInput(listFiltersSchema, rawFilters);
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    throw new ValidationError("A data inicial deve ser igual ou anterior à final.", { dateTo: ["A data inicial deve ser igual ou anterior à final."] });
  }
  const dateColumn = filters.dateField === "completed" ? certificates.completedOn : certificates.deliveredOn;

  const where = and(
    certificateScope(actor),
    filters.dateFrom ? gte(dateColumn, filters.dateFrom) : undefined,
    filters.dateTo ? lte(dateColumn, filters.dateTo) : undefined,
    filters.search ? ilike(leads.name, `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`) : undefined,
  );
  const base = () =>
    db
      .select({ total: count(), students: countDistinct(sales.leadId) })
      .from(certificates)
      .innerJoin(saleItems, eq(saleItems.id, certificates.saleItemId))
      .innerJoin(sales, eq(sales.id, saleItems.saleId))
      .innerJoin(responsible, eq(responsible.id, sales.sellerId))
      .innerJoin(leads, eq(leads.id, sales.leadId));
  const [{ total, students }] = await base().where(where);

  const pageSize = filters.pageSize ?? CERTIFICATE_PAGE_SIZES[0];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(filters.page ?? 1, totalPages);
  const rows =
    total === 0
      ? []
      : await db
          .select({
            id: certificates.id,
            studentName: leads.name,
            leadId: leads.id,
            courseName: courses.name,
            institutionName: courses.institutionName,
            sellerName: responsible.name,
            saleId: sales.id,
            saleDate: sales.saleDate,
            saleStatus: sales.status,
            removedAt: saleItems.removedAt,
            completedOn: certificates.completedOn,
            deliveredOn: certificates.deliveredOn,
            certifier: certificates.certifier,
            createdByName: registrar.name,
            createdAt: certificates.createdAt,
          })
          .from(certificates)
          .innerJoin(saleItems, eq(saleItems.id, certificates.saleItemId))
          .innerJoin(sales, eq(sales.id, saleItems.saleId))
          .innerJoin(responsible, eq(responsible.id, sales.sellerId))
          .innerJoin(leads, eq(leads.id, sales.leadId))
          .innerJoin(courses, eq(courses.id, saleItems.courseId))
          .innerJoin(registrar, eq(registrar.id, certificates.createdBy))
          .where(where)
          .orderBy(desc(dateColumn), desc(certificates.createdAt), desc(certificates.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize);

  return {
    items: rows.map(({ removedAt, ...row }) => ({ ...row, itemRemoved: removedAt !== null })),
    page,
    pageSize,
    total,
    students,
    totalPages,
  };
}

export type ItemCertificate = { id: string; completedOn: string; deliveredOn: string; certifier: string };

/**
 * Certificados dos itens ATUAIS de uma venda no escopo do ator, por id do
 * item (para o detalhe da venda). Venda fora do escopo → NotFound.
 */
export async function getSaleItemCertificates({ db, actor }: ServiceContext, rawSaleId: unknown): Promise<Record<string, ItemCertificate>> {
  assertPermission(actor, "certificates:operate");
  const saleId = parseInput(idSchema, rawSaleId);
  const [sale] = await db
    .select({ id: sales.id })
    .from(sales)
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .where(and(eq(sales.id, saleId), certificateScope(actor)))
    .limit(1);
  if (!sale) throw new NotFoundError();

  const itemIds = db.select({ id: saleItems.id }).from(saleItems).where(and(eq(saleItems.saleId, saleId), isNull(saleItems.removedAt)));
  const rows = await db
    .select({
      saleItemId: certificates.saleItemId,
      id: certificates.id,
      completedOn: certificates.completedOn,
      deliveredOn: certificates.deliveredOn,
      certifier: certificates.certifier,
    })
    .from(certificates)
    .where(inArray(certificates.saleItemId, itemIds));
  return Object.fromEntries(rows.map(({ saleItemId, ...certificate }) => [saleItemId, certificate]));
}
