import { and, asc, count, eq, gte, ilike, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { buildInstallmentSchedule, INSTALLMENT_FILTERS, INSTALLMENT_PAGE_SIZES, MAX_INSTALLMENTS } from "@/lib/installments";
import type { Actor } from "@/server/authz/actor";
import { assertPermission } from "@/server/authz/permissions";
import { ownedScope } from "@/server/authz/scope";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { ServiceContext } from "@/server/context";
import { installments, leads, sales, users, type InstallmentStatus, type PaymentMethod, type SaleStatus } from "@/server/db/schema";
import { runTransaction } from "@/server/db/transaction";
import type { Database } from "@/server/db/types";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { idSchema, parseInput } from "@/server/validation";

/**
 * Parcelas do cartão (Documento Mestre §12; decisão C52).
 *
 * - Só CARTÃO tem parcelas; Pix é à vista. Parcela n vence n meses após a data
 *   da venda; os centavos que sobram ficam na 1ª (src/lib/installments.ts; o
 *   banco confere a mesma regra no COMMIT).
 * - O cronograma acompanha a venda, na MESMA transação das operações de venda
 *   (sales.service, com a venda já travada FOR UPDATE): criado no registro;
 *   refeito quando total, pagamento, parcelas ou data mudam — recusado se há
 *   parcela paga; estorno cancela as em aberto; reativação as reabre.
 * - Pagamento (ADMIN, SUPERVISOR, SELLER; escopo C50): uma vez, sem baixa
 *   parcial nem desfazer; trava a venda (FOR SHARE) antes da parcela, a mesma
 *   ordem das operações de venda. Auditoria `installment.paid`.
 * - Comissão, faturamento, ranking e dashboard NÃO dependem de parcelas (C45).
 */

export const INSTALLMENTS_PAID_LOCKED =
  "Esta venda tem parcela paga: total, forma de pagamento, quantidade de parcelas e data da venda não podem mais ser alterados.";
export const INSTALLMENT_ALREADY_PAID = "Esta parcela já está paga.";
export const INSTALLMENT_NOT_OPEN = "Só parcelas em aberto podem ser marcadas como pagas. Atualize a página.";
export const INSTALLMENTS_EXCEED_TOTAL =
  "A quantidade de parcelas não pode ser maior que o valor da venda em centavos: cada parcela precisa ter pelo menos R$ 0,01.";

/** Erro de quantidade de parcelas acima do teto técnico do sistema (MAX_INSTALLMENTS), no campo `installmentCount`. */
export const INSTALLMENTS_OVER_LIMIT = `Use no máximo ${MAX_INSTALLMENTS.toLocaleString("pt-BR")} parcelas (limite técnico do sistema).`;

/**
 * Teto técnico (MAX_INSTALLMENTS). Chamar na criação e SÓ quando a edição
 * altera a quantidade: uma venda antiga acima do teto continua editável no resto.
 */
export function assertInstallmentCountWithinLimit(installmentCount: number | null | undefined): void {
  if (installmentCount != null && installmentCount > MAX_INSTALLMENTS) {
    throw new ValidationError(INSTALLMENTS_OVER_LIMIT, { installmentCount: [INSTALLMENTS_OVER_LIMIT] });
  }
}

/**
 * Cartão: a quantidade de parcelas não pode passar do total da venda em
 * centavos, para que cada parcela tenha pelo menos 1 centavo (o banco exige
 * amount_cents > 0, 006). Chamar ANTES de gravar a venda, na criação e na
 * edição (inclusive quando a remoção de itens ou a correção de preços reduz o
 * total). Independe do teto técnico (assertInstallmentCountWithinLimit).
 */
export function assertInstallmentsFitTotal(paymentMethod: PaymentMethod, installmentCount: number | null | undefined, totalCents: number): void {
  if (paymentMethod === "CARD" && installmentCount != null && installmentCount > totalCents) {
    throw new ValidationError(INSTALLMENTS_EXCEED_TOTAL, { installmentCount: [INSTALLMENTS_EXCEED_TOTAL] });
  }
}

/** Dados da venda que definem o cronograma. */
export type ScheduleSale = {
  id: string;
  status: SaleStatus;
  saleDate: string;
  totalCents: number;
  paymentMethod: PaymentMethod;
  installmentCount: number | null;
};

// ---------------------------------------------------------------------------
// Cronograma (uso interno do serviço de vendas, dentro da transação dele)
// ---------------------------------------------------------------------------

/** Cria o cronograma atual: cartão → parcelas (canceladas se a venda está estornada); Pix → nada. */
export async function createInstallmentSchedule(tx: Database, sale: ScheduleSale): Promise<void> {
  if (sale.paymentMethod !== "CARD" || !sale.installmentCount) return;
  const status: InstallmentStatus = sale.status === "ACTIVE" ? "OPEN" : "CANCELED";
  await tx
    .insert(installments)
    .values(buildInstallmentSchedule(sale.saleDate, sale.totalCents, sale.installmentCount).map((p) => ({ saleId: sale.id, ...p, status })));
}

/** Recusa a mudança do cronograma se a venda tem parcela paga (C52). Chamar ANTES de gravar a venda. */
export async function assertScheduleChangeable(tx: Database, saleId: string): Promise<void> {
  const [paid] = await tx
    .select({ id: installments.id })
    .from(installments)
    .where(and(eq(installments.saleId, saleId), isNull(installments.replacedAt), eq(installments.status, "PAID")))
    .limit(1);
  if (paid) throw new ValidationError(INSTALLMENTS_PAID_LOCKED);
}

/** Refaz o cronograma: o atual fica cancelado como histórico (replaced_at) e o novo segue a venda. */
export async function replaceInstallmentSchedule(tx: Database, sale: ScheduleSale): Promise<void> {
  await assertScheduleChangeable(tx, sale.id);
  await tx
    .update(installments)
    .set({ status: "CANCELED", replacedAt: sql`now()` })
    .where(and(eq(installments.saleId, sale.id), isNull(installments.replacedAt)));
  await createInstallmentSchedule(tx, sale);
}

/** Estorno: as parcelas em aberto do cronograma atual ficam canceladas; as pagas continuam pagas. */
export async function cancelOpenInstallments(tx: Database, saleId: string): Promise<void> {
  await tx
    .update(installments)
    .set({ status: "CANCELED" })
    .where(and(eq(installments.saleId, saleId), isNull(installments.replacedAt), eq(installments.status, "OPEN")));
}

/** Reativação: as canceladas do cronograma atual voltam a ficar em aberto. */
export async function reopenCanceledInstallments(tx: Database, saleId: string): Promise<void> {
  await tx
    .update(installments)
    .set({ status: "OPEN" })
    .where(and(eq(installments.saleId, saleId), isNull(installments.replacedAt), eq(installments.status, "CANCELED")));
}

// ---------------------------------------------------------------------------
// Pagamento
// ---------------------------------------------------------------------------

const responsible = alias(users, "installment_seller");
const payer = alias(users, "installment_payer");

/** Escopo pela venda da parcela (C50: equipe ATUAL do vendedor responsável). */
function installmentScope(actor: Actor): SQL | undefined {
  return ownedScope(actor, { ownerId: sales.sellerId, teamId: responsible.teamId });
}

/** "Hoje" no fuso único do negócio (AAAA-MM-DD). */
function businessToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(now);
}

const markPaidSchema = z.strictObject({ installmentId: idSchema });

/**
 * Marca uma parcela EM ABERTO do cronograma atual como paga (data/hora do
 * servidor e autor). Trava a venda (FOR SHARE) e depois a parcela (FOR
 * UPDATE): edição, estorno e reativação concorrentes (que travam a venda FOR
 * UPDATE) esperam ou são vistos; dois pagamentos da mesma parcela → o segundo
 * é recusado.
 */
export async function markInstallmentPaid(ctx: ServiceContext, input: unknown): Promise<void> {
  const { db, actor } = ctx;
  assertPermission(actor, "installments:markPaid");
  const { installmentId } = parseInput(markPaidSchema, input);

  await runTransaction(db, async (tx) => {
    const [seen] = await tx
      .select({ saleId: installments.saleId })
      .from(installments)
      .innerJoin(sales, eq(sales.id, installments.saleId))
      .innerJoin(responsible, eq(responsible.id, sales.sellerId))
      .where(and(eq(installments.id, installmentId), installmentScope(actor)))
      .limit(1);
    if (!seen) throw new NotFoundError();

    const [sale] = await tx
      .select({ id: sales.id, sellerTeamId: responsible.teamId })
      .from(sales)
      .innerJoin(responsible, eq(responsible.id, sales.sellerId))
      .where(and(eq(sales.id, seen.saleId), installmentScope(actor)))
      .for("share", { of: sales });
    if (!sale) throw new NotFoundError();

    const [installment] = await tx
      .select({
        number: installments.number,
        amountCents: installments.amountCents,
        dueDate: installments.dueDate,
        status: installments.status,
        replacedAt: installments.replacedAt,
      })
      .from(installments)
      .where(eq(installments.id, installmentId))
      .for("update");
    if (installment.status === "PAID") throw new ConflictError(INSTALLMENT_ALREADY_PAID);
    if (installment.status !== "OPEN" || installment.replacedAt) throw new ValidationError(INSTALLMENT_NOT_OPEN);

    await tx.update(installments).set({ status: "PAID", paidBy: actor.userId }).where(eq(installments.id, installmentId));
    await recordAudit(tx, {
      actorId: actor.userId,
      action: "installment.paid",
      entityType: "installment",
      entityId: installmentId,
      teamId: sale.sellerTeamId,
      metadata: { saleId: sale.id, number: installment.number, amountCents: installment.amountCents, dueDate: installment.dueDate },
    });
  });
}

// ---------------------------------------------------------------------------
// Consultas (só o cronograma atual)
// ---------------------------------------------------------------------------

const listFiltersSchema = z.strictObject({
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.union(INSTALLMENT_PAGE_SIZES.map((size) => z.literal(size))).optional(),
  status: z.enum(INSTALLMENT_FILTERS).optional(),
  /** Período pelo vencimento. */
  dueFrom: z.iso.date({ error: "Data inválida." }).optional(),
  dueTo: z.iso.date({ error: "Data inválida." }).optional(),
  /** Nome do lead (trecho). */
  search: z.string().trim().max(120).optional(),
});

export type InstallmentListEntry = {
  id: string;
  saleId: string;
  leadName: string;
  sellerName: string;
  number: number;
  installmentCount: number;
  amountCents: number;
  dueDate: string;
  status: InstallmentStatus;
  paidAt: Date | null;
  paidByName: string | null;
  saleStatus: SaleStatus;
};

export type InstallmentList = {
  items: InstallmentListEntry[];
  page: number;
  pageSize: number;
  total: number;
  /** Soma dos valores das parcelas nos filtros. */
  amountCents: number;
  totalPages: number;
};

const listView = {
  id: installments.id,
  saleId: sales.id,
  leadName: leads.name,
  sellerName: responsible.name,
  number: installments.number,
  installmentCount: sql<number>`${sales.installmentCount}`.mapWith(Number),
  amountCents: installments.amountCents,
  dueDate: installments.dueDate,
  status: installments.status,
  paidAt: installments.paidAt,
  paidByName: payer.name,
  saleStatus: sales.status,
};

/** Listagem paginada no banco; escopo e filtros no mesmo WHERE, inclusive no resumo. */
export async function listInstallments({ db, actor }: ServiceContext, rawFilters: unknown = {}): Promise<InstallmentList> {
  assertPermission(actor, "installments:markPaid");
  const filters = parseInput(listFiltersSchema, rawFilters);
  if (filters.dueFrom && filters.dueTo && filters.dueFrom > filters.dueTo) {
    throw new ValidationError("A data inicial deve ser igual ou anterior à final.", { dueTo: ["A data inicial deve ser igual ou anterior à final."] });
  }
  const statusCondition = (): SQL | undefined => {
    switch (filters.status) {
      case undefined:
        return undefined;
      case "OVERDUE":
        return and(eq(installments.status, "OPEN"), lt(installments.dueDate, businessToday()));
      default:
        return eq(installments.status, filters.status);
    }
  };
  const where = and(
    isNull(installments.replacedAt),
    installmentScope(actor),
    statusCondition(),
    filters.dueFrom ? gte(installments.dueDate, filters.dueFrom) : undefined,
    filters.dueTo ? lte(installments.dueDate, filters.dueTo) : undefined,
    filters.search ? ilike(leads.name, `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`) : undefined,
  );

  const [{ total, amountCents }] = await db
    .select({ total: count(), amountCents: sql<number>`coalesce(sum(${installments.amountCents}), 0)::bigint`.mapWith(Number) })
    .from(installments)
    .innerJoin(sales, eq(sales.id, installments.saleId))
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .innerJoin(leads, eq(leads.id, sales.leadId))
    .where(where);

  const pageSize = filters.pageSize ?? INSTALLMENT_PAGE_SIZES[0];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(filters.page ?? 1, totalPages);
  const items =
    total === 0
      ? []
      : await db
          .select(listView)
          .from(installments)
          .innerJoin(sales, eq(sales.id, installments.saleId))
          .innerJoin(responsible, eq(responsible.id, sales.sellerId))
          .innerJoin(leads, eq(leads.id, sales.leadId))
          .leftJoin(payer, eq(payer.id, installments.paidBy))
          .where(where)
          .orderBy(asc(installments.dueDate), asc(leads.name), asc(installments.saleId), asc(installments.number))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
  return { items, page, pageSize, total, amountCents, totalPages };
}

/** Cronograma atual de uma venda no escopo do ator (detalhe da venda). Fora do escopo → NotFound. */
export async function getSaleInstallments({ db, actor }: ServiceContext, rawSaleId: unknown): Promise<InstallmentListEntry[]> {
  assertPermission(actor, "installments:markPaid");
  const saleId = parseInput(idSchema, rawSaleId);
  const [sale] = await db
    .select({ id: sales.id })
    .from(sales)
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .where(and(eq(sales.id, saleId), installmentScope(actor)))
    .limit(1);
  if (!sale) throw new NotFoundError();
  return db
    .select(listView)
    .from(installments)
    .innerJoin(sales, eq(sales.id, installments.saleId))
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .innerJoin(leads, eq(leads.id, sales.leadId))
    .leftJoin(payer, eq(payer.id, installments.paidBy))
    .where(and(eq(installments.saleId, saleId), isNull(installments.replacedAt)))
    .orderBy(asc(installments.number));
}
