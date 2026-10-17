import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { REQUEST_ID_REUSED, SALE_CHANGED_CONCURRENTLY, SALE_PAGE_SIZES } from "@/lib/sales";
import type { Actor } from "@/server/authz/actor";
import { assertPermission, hasPermission } from "@/server/authz/permissions";
import { ownedScope } from "@/server/authz/scope";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { ServiceContext } from "@/server/context";
import { isUniqueViolation } from "@/server/db/errors";
import {
  courseCosts,
  courses,
  leads,
  PAYMENT_METHODS,
  SALE_STATUSES,
  saleEvents,
  saleItems,
  sales,
  teams,
  users,
  type PaymentMethod,
  type SaleEventType,
  type SaleStatus,
} from "@/server/db/schema";
import { RetryTransactionError, runTransaction } from "@/server/db/transaction";
import type { Database } from "@/server/db/types";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import {
  applySaleReversalToLead,
  applySaleToLead,
  lockLeadForChange,
  lockLeadForSale,
  planSaleReversal,
  type SaleReversalPlan,
} from "@/server/modules/leads/leads.service";
import {
  assertScheduleChangeable,
  cancelOpenInstallments,
  createInstallmentSchedule,
  reopenCanceledInstallments,
  replaceInstallmentSchedule,
} from "@/server/modules/installments/installments.service";
import { idSchema, parseInput } from "@/server/validation";

/**
 * Vendas — Etapa 3a: registro e consultas (Documento Mestre §11, §13, §14;
 * decisões C36–C38 em docs/ARQUITETURA.md). Estorno, reativação e edição
 * ficam para a Etapa 3b.
 *
 * O banco (migration 003) garante integridade estrutural, snapshots de custo
 * conferidos, carimbos de tempo, coerência lead × vendas e a auditoria
 * (sale_events: metadata calculado pelo PostgreSQL). Este serviço faz RBAC,
 * escopo, escolha do vendedor, data, comissão vigente, linha do tempo do lead
 * e a ordem de travas: usuários → equipes → lead → venda → itens.
 *
 * Escopo de leitura: SELLER, as vendas de que é responsável; SUPERVISOR, as
 * vendas cujo responsável está HOJE na equipe que ele lidera (users.team_id,
 * não sales.team_id); ADMIN, todas. Fora do escopo → NotFound.
 *
 * Custos de bolsa (cost_snapshot_cents) só saem em getSaleWithCost e no
 * histórico de quem tem `finance:viewCostAndProfit`.
 */

// ---------------------------------------------------------------------------
// Tipos de saída
// ---------------------------------------------------------------------------

export type SaleListItem = {
  id: string;
  leadId: string;
  leadName: string;
  sellerId: string;
  sellerName: string;
  /** Equipe de atribuição da venda (histórica: a do vendedor quando passou a ser o responsável). */
  teamId: string;
  teamName: string;
  saleDate: string;
  totalCents: number;
  paymentMethod: PaymentMethod;
  installmentCount: number | null;
  status: SaleStatus;
  itemCount: number;
  /** Nomes dos cursos atuais, na ordem de inclusão (para a listagem). */
  courseNames: string;
  createdAt: Date;
};

/**
 * Último estorno de uma venda estornada (área de Estornos), lido de
 * `sale_events`: o evento REVERSED de maior id. Só se estorna venda válida e só
 * se reativa venda estornada, então numa venda hoje estornada esse é o estorno
 * vigente; estornos anteriores (antes de uma reativação) continuam no histórico.
 */
export type SaleReversalInfo = { occurredAt: Date; actorName: string; reason: string };

/** Item da listagem; `lastReversal` só vem preenchido para venda estornada. */
export type SaleListEntry = SaleListItem & { lastReversal: SaleReversalInfo | null };

export type SaleItemView = {
  id: string;
  courseId: string;
  courseName: string;
  institutionName: string;
  /** Preço de venda desta ocorrência do curso (004). */
  priceCents: number;
  commissionSnapshotCents: number;
  addedAt: Date;
};

export type SaleItemWithCost = SaleItemView & {
  costSnapshotCents: number;
  /** Preço de venda − custo da bolsa (somente `finance:viewCostAndProfit`). */
  profitCents: number;
};

export type SaleView = Omit<SaleListItem, "itemCount" | "courseNames"> & {
  /**
   * Versão para controle de concorrência: id do último evento da venda (todo
   * alteração confirmada gera um evento — o banco exige). Enviada de volta em
   * updateSale/reverseSale/reactivateSale como `expectedVersion`.
   */
  version: number;
  /** Supervisor da equipe quando o vendedor passou a ser o responsável (histórico). */
  supervisorName: string | null;
  createdByName: string;
  updatedAt: Date;
  items: SaleItemView[];
  commissionTotalCents: number;
};

export type SaleWithCost = Omit<SaleView, "items"> & { items: SaleItemWithCost[]; costTotalCents: number; profitTotalCents: number };

export type SaleHistoryEntry = {
  id: number;
  type: SaleEventType;
  occurredAt: Date;
  actorName: string;
  reason: string | null;
  /** Calculado pelo banco. Sem custos de bolsa para quem não pode vê-los. */
  metadata: Record<string, unknown>;
};

export type CreateSaleResult = {
  saleId: string;
  /** true = a mesma solicitação já tinha sido processada; nada foi gravado de novo. */
  replayed: boolean;
};

export type Paginated<T> = { items: T[]; page: number; pageSize: number; total: number; totalPages: number };

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

/** Limite técnico das colunas integer do PostgreSQL (não é regra de negócio). */
const INT4_MAX = 2_147_483_647;
/** Limite técnico de itens por solicitação (tamanho do payload), não de negócio. */
const MAX_ITEMS_PER_REQUEST = 100;

export const SELLER_REQUIRED = "Selecione o vendedor responsável pela venda.";
export const SELLER_NOT_ACTIVE = "Selecione um vendedor ativo.";
export const SELLER_OUTSIDE_TEAM = "Selecione você ou um vendedor ativo da sua equipe.";
export const SELLER_TEAM_INACTIVE = "A equipe do vendedor selecionado está inativa.";
export const LEAD_IN_TRASH = "Lead na Lixeira não pode receber venda. Recupere-o primeiro.";
export const COURSE_NOT_AVAILABLE = "Selecione apenas cursos ativos.";
/** Definida em @/lib/sales: o formulário a reconhece e não a trata como sucesso. */
export { REQUEST_ID_REUSED };

export const TOTAL_TOO_HIGH = "O valor total da venda passa do limite permitido.";

/** Preço de venda de UM item (o total da venda é a soma, calculada no servidor). */
const priceCentsSchema = z
  .number({ error: "Informe o preço do curso." })
  .int("Preço inválido.")
  .min(1, "O preço de cada curso deve ser maior que zero.")
  .max(INT4_MAX, "Preço acima do limite permitido.");

const installmentCountSchema = z
  .number({ error: "Quantidade de parcelas inválida." })
  .int("Quantidade de parcelas inválida.")
  .min(1, "Informe ao menos 1 parcela.")
  .max(INT4_MAX, "Quantidade de parcelas inválida.");

const itemsToAddSchema = z
  .array(z.strictObject({ courseId: idSchema, priceCents: priceCentsSchema }), { error: "Inclua pelo menos um curso." })
  .max(MAX_ITEMS_PER_REQUEST, `Use no máximo ${MAX_ITEMS_PER_REQUEST} cursos por venda.`);

const createSaleSchema = z
  .strictObject({
    /** UUID da operação gerado pelo formulário: vira o id da venda (idempotência). */
    requestId: idSchema,
    leadId: idSchema,
    /** Vendedor responsável. SELLER pode omitir (= ele mesmo). */
    sellerId: idSchema.optional(),
    /** Só com `sales:setDate` (ADMIN). Padrão: hoje no fuso do negócio. */
    saleDate: z.iso.date({ error: "Data inválida." }).optional(),
    paymentMethod: z.enum(PAYMENT_METHODS, { error: "Selecione a forma de pagamento." }),
    installmentCount: installmentCountSchema.nullish(),
    /** Cada ocorrência de curso com o seu preço; o total é a soma (004). */
    items: itemsToAddSchema.min(1, "Inclua pelo menos um curso."),
  })
  .superRefine((value, ctx) => {
    if (value.paymentMethod === "PIX" && value.installmentCount != null) {
      ctx.addIssue({ code: "custom", path: ["installmentCount"], message: "Pix é à vista: não informe parcelas." });
    }
    if (value.paymentMethod === "CARD" && value.installmentCount == null) {
      ctx.addIssue({ code: "custom", path: ["installmentCount"], message: "Informe a quantidade de parcelas do cartão." });
    }
  });

type CreateSaleInput = z.output<typeof createSaleSchema>;

const listFiltersSchema = z.strictObject({
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.union(SALE_PAGE_SIZES.map((size) => z.literal(size))).optional(),
  status: z.enum(SALE_STATUSES).optional(),
  sellerId: idSchema.optional(),
  /** Equipe de atribuição da venda (sales.team_id). */
  teamId: idSchema.optional(),
  leadId: idSchema.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  dateFrom: z.iso.date({ error: "Data inválida." }).optional(),
  dateTo: z.iso.date({ error: "Data inválida." }).optional(),
  /** Nome do lead (trecho). */
  search: z.string().trim().max(120).optional(),
});

/** "Hoje" no fuso único do negócio (AAAA-MM-DD). */
function businessToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(now);
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/**
 * Registra uma venda para um lead ATIVO, em qualquer etapa (inclusive com
 * Follow-up 3 ou negociação vencidos — C37), numa única transação READ
 * COMMITTED:
 *
 *   1. usuários (ator, responsável atual do lead, vendedor escolhido) →
 *      equipes (do lead e do vendedor) → lead, por lockLeadForChange;
 *   2. revalida, com tudo travado: ator ativo e no escopo, lead ativo,
 *      vendedor SELLER ativo, com equipe ATIVA e permitido para o ator;
 *   3. cursos e custos de bolsa (FOR SHARE, a mesma ordem do trigger de itens):
 *      todos ativos e com custo; snapshot de custo e comissão vêm daqui e de
 *      business-rules.ts, nunca do formulário;
 *   4. venda → itens → lead (Fechamento, responsável = vendedor, SALE_CREATED)
 *      → sale_events CREATED por último (o banco calcula o metadata e confere
 *      tudo no COMMIT).
 *
 * Idempotência: `requestId` (UUID gerado pelo formulário) vira o id da venda.
 * Repetir a mesma solicitação devolve a venda já gravada (`replayed: true`);
 * reutilizar o id com outros dados é recusado.
 */
export async function createSale(ctx: ServiceContext, input: unknown): Promise<CreateSaleResult> {
  const { db, actor } = ctx;
  assertPermission(actor, "sales:create");
  const data = parseInput(createSaleSchema, input);
  if (data.saleDate !== undefined) assertPermission(actor, "sales:setDate");
  if (actor.role !== "SELLER" && !data.sellerId) throw new ValidationError(SELLER_REQUIRED, { sellerId: [SELLER_REQUIRED] });
  const sellerId = data.sellerId ?? actor.userId;
  const saleDate = data.saleDate ?? businessToday();

  try {
    return await runTransaction(db, async (tx) => {
      // Solicitação repetida já concluída (ex.: resposta perdida): devolve a
      // mesma venda sem gravar nada, mesmo que o lead tenha mudado de dono.
      const before = await findReplay(tx, actor, data, sellerId);
      if (before) return before;

      let lead;
      try {
        lead = await lockLeadForChange(tx, actor, data.leadId, [sellerId]);
      } catch (error) {
        // Uma cópia concorrente desta solicitação pode ter acabado de gravar e
        // tirado o lead do escopo (ex.: SELLER atribuiu a venda a um colega).
        if (error instanceof NotFoundError) {
          const replay = await findReplay(tx, actor, data, sellerId);
          if (replay) return replay;
        }
        throw error;
      }
      // Cópia concorrente que gravou enquanto esta esperava a trava do lead.
      const replay = await findReplay(tx, actor, data, sellerId);
      if (replay) return replay;

      if (lead.status !== "ACTIVE") throw new ValidationError(LEAD_IN_TRASH);
      const seller = await loadSaleSeller(tx, actor, sellerId);
      const costs = await lockCourseCosts(tx, data.items.map((item) => item.courseId));
      const totalCents = sumPrices(data.items);

      await tx.insert(sales).values({
        id: data.requestId,
        leadId: lead.id,
        sellerId: seller.id,
        teamId: seller.teamId,
        supervisorId: seller.supervisorId,
        saleDate,
        totalCents,
        paymentMethod: data.paymentMethod,
        installmentCount: data.installmentCount ?? null,
        createdBy: actor.userId,
      });
      await tx.insert(saleItems).values(
        data.items.map((item) => ({
          saleId: data.requestId,
          courseId: item.courseId,
          priceCents: item.priceCents,
          costSnapshotCents: costs.get(item.courseId)!,
          commissionSnapshotCents: BUSINESS_RULES.commissionPerItemCents,
          addedBy: actor.userId,
        })),
      );
      // Cartão: cronograma de parcelas (C52) na mesma transação; Pix: nenhum.
      await createInstallmentSchedule(tx, {
        id: data.requestId,
        status: "ACTIVE",
        saleDate,
        totalCents,
        paymentMethod: data.paymentMethod,
        installmentCount: data.installmentCount ?? null,
      });
      await applySaleToLead(tx, actor, lead, seller, data.requestId, "SALE_CREATED", {
        totalCents,
        paymentMethod: data.paymentMethod,
        installmentCount: data.installmentCount ?? null,
        itemCount: data.items.length,
      });
      // Por último: o banco calcula o retrato (venda + itens) e o confere no COMMIT.
      await tx.insert(saleEvents).values({ saleId: data.requestId, type: "CREATED", actorId: actor.userId });
      return { saleId: data.requestId, replayed: false };
    });
  } catch (error) {
    // Mesmo id já usado (por outro lead ou outra solicitação concluída entre a
    // verificação e a gravação).
    if (isUniqueViolation(error, "sales_pkey")) {
      const replay = await findReplay(db, actor, data, sellerId);
      if (replay) return replay;
      throw new ConflictError(REQUEST_ID_REUSED);
    }
    throw error;
  }
}

/** Total = soma dos preços (no servidor; o banco confere no COMMIT). */
function sumPrices(items: { priceCents: number }[]): number {
  const total = items.reduce((sum, item) => sum + item.priceCents, 0);
  if (total > INT4_MAX) throw new ValidationError(TOTAL_TOO_HIGH, { items: [TOTAL_TOO_HIGH] });
  return total;
}

/**
 * Venda já gravada com este `requestId`. Mesma solicitação (mesmo autor, lead,
 * vendedor, valores e cursos, conferidos contra o retrato CREATED gravado pelo
 * banco, que não muda com edições posteriores) → replay. Outros dados →
 * ConflictError, sem revelar a venda existente.
 */
async function findReplay(db: Database, actor: Actor, data: CreateSaleInput, sellerId: string): Promise<CreateSaleResult | null> {
  const [existing] = await db
    .select({ leadId: sales.leadId, createdBy: sales.createdBy, metadata: saleEvents.metadata })
    .from(sales)
    .leftJoin(saleEvents, and(eq(saleEvents.saleId, sales.id), eq(saleEvents.type, "CREATED")))
    .where(eq(sales.id, data.requestId))
    .limit(1);
  if (!existing) return null;

  const snapshot = existing.metadata as { sale?: Record<string, unknown>; items?: { courseId: string; priceCents?: number }[] } | null;
  const sale = snapshot?.sale;
  // Pares (curso, preço) em qualquer ordem: cursos repetidos com preços diferentes contam um a um.
  const pairs = (items: { courseId: string; priceCents?: number }[]) => items.map((i) => `${i.courseId}:${i.priceCents}`).sort();
  const sameItems = JSON.stringify(pairs(snapshot?.items ?? [])) === JSON.stringify(pairs(data.items));
  const same =
    !!sale &&
    existing.leadId === data.leadId &&
    existing.createdBy === actor.userId &&
    sale.sellerId === sellerId &&
    sale.totalCents === sumPrices(data.items) &&
    sale.paymentMethod === data.paymentMethod &&
    (sale.installmentCount ?? null) === (data.installmentCount ?? null) &&
    (data.saleDate === undefined || sale.saleDate === data.saleDate) &&
    sameItems;
  if (!same) throw new ConflictError(REQUEST_ID_REUSED);
  return { saleId: data.requestId, replayed: true };
}

/**
 * Vendedor responsável escolhido (ele e a equipe dele já travados por
 * lockLeadForChange: a leitura não muda até o COMMIT). SELLER ativo, com
 * equipe ATIVA (C38); SELLER-ator só escolhe a si ou um colega da própria
 * equipe; SUPERVISOR e ADMIN, qualquer vendedor ativo (C36).
 */
async function loadSaleSeller(
  db: Database,
  actor: Actor,
  sellerId: string,
): Promise<{ id: string; teamId: string; supervisorId: string | null }> {
  const [seller] = await db
    .select({ id: users.id, role: users.role, active: users.active, teamId: users.teamId, teamActive: teams.active, supervisorId: teams.supervisorId })
    .from(users)
    .leftJoin(teams, eq(teams.id, users.teamId))
    .where(eq(users.id, sellerId))
    .limit(1);
  if (!seller || seller.role !== "SELLER" || !seller.active || !seller.teamId) {
    throw new ValidationError(SELLER_NOT_ACTIVE, { sellerId: [SELLER_NOT_ACTIVE] });
  }
  if (actor.role === "SELLER" && seller.id !== actor.userId) {
    // Equipe ATUAL do ator, lida da linha dele (travada), não do Actor da requisição.
    const [me] = await db.select({ teamId: users.teamId }).from(users).where(eq(users.id, actor.userId)).limit(1);
    if (!me?.teamId || me.teamId !== seller.teamId) throw new ValidationError(SELLER_OUTSIDE_TEAM, { sellerId: [SELLER_OUTSIDE_TEAM] });
  }
  if (!seller.teamActive) throw new ValidationError(SELLER_TEAM_INACTIVE, { sellerId: [SELLER_TEAM_INACTIVE] });
  return { id: seller.id, teamId: seller.teamId, supervisorId: seller.supervisorId };
}

/**
 * Cursos (FOR SHARE) e depois custos (FOR SHARE), em ordem de id — a mesma
 * ordem do trigger de itens do 003, então uma alteração de custo concorrente
 * espera esta venda (ou termina antes e o snapshot já usa o valor novo).
 * Devolve o custo vigente de cada curso. Uso interno: nunca sai do serviço.
 */
async function lockCourseCosts(db: Database, courseIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(courseIds)];
  const found = await db
    .select({ id: courses.id, name: courses.name, active: courses.active })
    .from(courses)
    .where(inArray(courses.id, ids))
    .orderBy(asc(courses.id))
    .for("share");
  if (found.length !== ids.length || found.some((c) => !c.active)) {
    throw new ValidationError(COURSE_NOT_AVAILABLE, { items: [COURSE_NOT_AVAILABLE] });
  }
  const costs = await db
    .select({ courseId: courseCosts.courseId, costCents: courseCosts.costCents })
    .from(courseCosts)
    .where(inArray(courseCosts.courseId, ids))
    .orderBy(asc(courseCosts.courseId))
    .for("share");
  const byCourse = new Map(costs.map((c) => [c.courseId, c.costCents]));
  const withoutCost = found.filter((c) => !byCourse.has(c.id)).map((c) => c.name);
  if (withoutCost.length > 0) {
    const message = `Curso sem custo de bolsa cadastrado: ${withoutCost.join(", ")}. Peça ao administrador para cadastrá-lo.`;
    throw new ValidationError(message, { items: [message] });
  }
  return byCourse;
}

// ---------------------------------------------------------------------------
// Edição, estorno e reativação (Etapa 3b)
// ---------------------------------------------------------------------------

/** Definida em @/lib/sales: a interface a reconhece para oferecer "Atualizar venda". */
export { SALE_CHANGED_CONCURRENTLY };
export const SALE_REVERSED_READ_ONLY = "Venda estornada é somente leitura para o vendedor.";
export const SALE_ALREADY_REVERSED = "Esta venda já está estornada.";
export const SALE_ALREADY_ACTIVE = "Esta venda já está válida.";
export const SALE_NEEDS_ITEM = "A venda precisa de pelo menos um curso.";
export const ITEM_NOT_IN_SALE = "Selecione apenas cursos atuais desta venda.";
export const ITEM_REPEATED_IN_REQUEST = "Cada curso da venda pode ser removido ou ter o preço corrigido uma vez por alteração.";
export const LEAD_IN_TRASH_REACTIVATE = "O lead desta venda está na Lixeira. Recupere o lead antes de reativar a venda.";
export const RESPONSIBLE_INVALID_REACTIVATE =
  "O vendedor responsável por esta venda está inativo, sem equipe ou em equipe inativa. Troque o responsável por um vendedor ativo de equipe ativa antes de reativar.";

const expectedVersionSchema = z.number({ error: "Recarregue a venda e tente novamente." }).int().min(1);
const reasonSchema = z
  .string({ error: "Informe o motivo." })
  .trim()
  .min(1, "Informe o motivo.")
  .max(2000, "Use no máximo 2.000 caracteres.");

/**
 * Edição: só os campos enviados são considerados. Itens: `addItems` inclui
 * ocorrências novas com preço (snapshots de custo e comissão vigentes),
 * `removeItemIds` remove itens atuais (remoção lógica) e `repriceItems` corrige
 * o preço de itens atuais sem recriá-los (custo e comissão ficam iguais).
 * Snapshots nunca vêm do cliente. O total NÃO é editável: é a soma dos preços
 * dos itens atuais, recalculada na mesma transação (o banco confere no COMMIT).
 */
const updateSaleSchema = z.strictObject({
  expectedVersion: expectedVersionSchema,
  /** SUPERVISOR/ADMIN (`sales:changeSeller`). */
  sellerId: idSchema.optional(),
  /** ADMIN (`sales:setDate`). */
  saleDate: z.iso.date({ error: "Data inválida." }).optional(),
  /** SUPERVISOR/ADMIN (`sales:editFinancial`). */
  paymentMethod: z.enum(PAYMENT_METHODS, { error: "Selecione a forma de pagamento." }).optional(),
  installmentCount: installmentCountSchema.nullable().optional(),
  /** Todos (`sales:edit`): SELLER só inclui cursos. */
  addItems: itemsToAddSchema.optional(),
  /** SUPERVISOR/ADMIN (`sales:editFinancial`). */
  removeItemIds: z.array(idSchema).max(MAX_ITEMS_PER_REQUEST, `Use no máximo ${MAX_ITEMS_PER_REQUEST} cursos por venda.`).optional(),
  /** SUPERVISOR/ADMIN (`sales:editFinancial`). */
  repriceItems: z
    .array(z.strictObject({ itemId: idSchema, priceCents: priceCentsSchema }))
    .max(MAX_ITEMS_PER_REQUEST, `Use no máximo ${MAX_ITEMS_PER_REQUEST} cursos por venda.`)
    .optional(),
});

const statusChangeSchema = z.strictObject({ expectedVersion: expectedVersionSchema, reason: reasonSchema });

export type SaleChangeResult = {
  saleId: string;
  /** Nova versão da venda (ou a mesma, se nada mudou). */
  version: number;
  changed: boolean;
};

export type SaleReversalResult = SaleChangeResult & { leadOutcome: SaleReversalPlan["kind"] };

/** Versão atual: id do último evento da venda. */
async function currentVersion(db: Database, saleId: string): Promise<number> {
  const [row] = await db
    .select({ version: sql<number>`max(${saleEvents.id})`.mapWith(Number) })
    .from(saleEvents)
    .where(eq(saleEvents.saleId, saleId));
  return row.version;
}

/**
 * Travas de toda alteração de venda, na ordem global usuários → equipes →
 * lead → venda (→ itens, nas gravações):
 *   1. lê a venda (escopo da VENDA, sem trava): lead e responsável atual;
 *   2. lockLeadForSale: ator, responsável do lead, responsável da venda e
 *      vendedores informados → equipes deles → lead (sem escopo de lead: a
 *      autorização é pela venda);
 *   3. trava a venda (FOR UPDATE só da linha de sales), de novo com escopo;
 *      responsável mudou desde 1 → transação refeita;
 *   4. confere a versão esperada: qualquer alteração confirmada entre a
 *      leitura do cliente e agora → conflito (nada é gravado). É o que impede
 *      duplicar uma operação reenviada depois de concluída.
 */
async function lockSaleForChange(tx: Database, actor: Actor, saleId: string, expectedVersion: number, extraSellerIds: string[]) {
  const [seen] = await tx
    .select({ leadId: sales.leadId, sellerId: sales.sellerId })
    .from(sales)
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .where(and(eq(sales.id, saleId), saleScope(actor)))
    .limit(1);
  if (!seen) throw new NotFoundError();

  const lead = await lockLeadForSale(tx, actor, seen.leadId, [seen.sellerId, ...extraSellerIds]);
  const [sale] = await tx
    .select({
      id: sales.id,
      leadId: sales.leadId,
      sellerId: sales.sellerId,
      status: sales.status,
      saleDate: sales.saleDate,
      totalCents: sales.totalCents,
      paymentMethod: sales.paymentMethod,
      installmentCount: sales.installmentCount,
    })
    .from(sales)
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .where(and(eq(sales.id, saleId), saleScope(actor)))
    .limit(1)
    .for("update", { of: sales });
  if (!sale) throw new NotFoundError();
  if (sale.sellerId !== seen.sellerId) throw new RetryTransactionError();
  if ((await currentVersion(tx, saleId)) !== expectedVersion) throw new ConflictError(SALE_CHANGED_CONCURRENTLY);
  return { lead, sale };
}

/**
 * Edita uma venda no escopo do ator, numa transação READ COMMITTED:
 *   - SELLER: só INCLUIR cursos (com preço) em venda VÁLIDA; nunca remover
 *     item, corrigir preço, pagamento, parcelas, data ou responsável (campos
 *     enviados → Forbidden) — remover e reincluir não é possível;
 *   - SUPERVISOR: também remover itens, corrigir preços, pagamento, parcelas e
 *     responsável; venda estornada pode ser corrigida;
 *   - ADMIN: tudo isso e a data.
 * Lead da venda é imutável. Itens novos recebem custo e comissão vigentes;
 * itens existentes mantêm os snapshots (inclusive na correção de preço);
 * remoção é lógica (removed_at/by). O total é sempre a soma dos preços.
 * Troca de responsável: novo vendedor ativo de equipe ativa; a venda passa
 * para a equipe atual dele e o supervisor dela; se a venda é válida, o lead
 * acompanha (SALE_SELLER_CHANGED). O banco grava o UPDATED com antes/depois
 * (campos e itens) e confere tudo no COMMIT. Sem mudança líquida, nada é
 * gravado.
 */
export async function updateSale(ctx: ServiceContext, rawId: unknown, input: unknown): Promise<SaleChangeResult> {
  const { db, actor } = ctx;
  assertPermission(actor, "sales:edit");
  const id = parseInput(idSchema, rawId);
  const data = parseInput(updateSaleSchema, input);
  if (
    data.paymentMethod !== undefined ||
    data.installmentCount !== undefined ||
    data.removeItemIds !== undefined ||
    data.repriceItems !== undefined
  ) {
    assertPermission(actor, "sales:editFinancial");
  }
  if (data.saleDate !== undefined) assertPermission(actor, "sales:setDate");
  if (data.sellerId !== undefined) assertPermission(actor, "sales:changeSeller");

  return runTransaction(db, async (tx) => {
    const { lead, sale } = await lockSaleForChange(tx, actor, id, data.expectedVersion, data.sellerId ? [data.sellerId] : []);
    if (sale.status === "REVERSED" && !hasPermission(actor, "sales:editReversed")) throw new ValidationError(SALE_REVERSED_READ_ONLY);

    const changes: Partial<typeof sales.$inferInsert> = {};
    let newSeller: Awaited<ReturnType<typeof loadSaleSeller>> | null = null;
    if (data.sellerId !== undefined && data.sellerId !== sale.sellerId) {
      newSeller = await loadSaleSeller(tx, actor, data.sellerId);
      Object.assign(changes, { sellerId: newSeller.id, teamId: newSeller.teamId, supervisorId: newSeller.supervisorId });
    }
    if (data.saleDate !== undefined && data.saleDate !== sale.saleDate) changes.saleDate = data.saleDate;
    const paymentMethod = data.paymentMethod ?? sale.paymentMethod;
    const installmentCount = data.installmentCount !== undefined ? data.installmentCount : sale.installmentCount;
    if (paymentMethod === "PIX" && installmentCount !== null) {
      throw new ValidationError("Pix é à vista: não informe parcelas.", { installmentCount: ["Pix é à vista: envie parcelas vazias."] });
    }
    if (paymentMethod === "CARD" && installmentCount === null) {
      throw new ValidationError("Informe a quantidade de parcelas do cartão.", { installmentCount: ["Informe a quantidade de parcelas do cartão."] });
    }
    if (paymentMethod !== sale.paymentMethod) changes.paymentMethod = paymentMethod;
    if (installmentCount !== sale.installmentCount) changes.installmentCount = installmentCount;

    const removeIds = data.removeItemIds ?? [];
    const repriceRequests = data.repriceItems ?? [];
    const toAdd = data.addItems ?? [];
    const touched = [...removeIds, ...repriceRequests.map((r) => r.itemId)];
    if (new Set(touched).size !== touched.length) {
      throw new ValidationError(ITEM_REPEATED_IN_REQUEST, { items: [ITEM_REPEATED_IN_REQUEST] });
    }
    const currentItems = await tx
      .select({ id: saleItems.id, priceCents: saleItems.priceCents })
      .from(saleItems)
      .where(and(eq(saleItems.saleId, id), isNull(saleItems.removedAt)));
    const currentPrice = new Map(currentItems.map((item) => [item.id, item.priceCents]));
    if (touched.some((itemId) => !currentPrice.has(itemId))) {
      throw new ValidationError(ITEM_NOT_IN_SALE, { items: [ITEM_NOT_IN_SALE] });
    }
    if (currentItems.length - removeIds.length + toAdd.length < 1) throw new ValidationError(SALE_NEEDS_ITEM, { items: [SALE_NEEDS_ITEM] });
    // Correção para o mesmo preço não é mudança.
    const reprices = repriceRequests.filter((r) => r.priceCents !== currentPrice.get(r.itemId));
    const costs = toAdd.length > 0 ? await lockCourseCosts(tx, toAdd.map((item) => item.courseId)) : new Map<string, number>();
    const removed = new Set(removeIds);
    const repriced = new Map(reprices.map((r) => [r.itemId, r.priceCents]));
    const newTotal = sumPrices([
      ...currentItems.filter((item) => !removed.has(item.id)).map((item) => ({ priceCents: repriced.get(item.id) ?? item.priceCents })),
      ...toAdd,
    ]);
    if (newTotal !== sale.totalCents) changes.totalCents = newTotal;

    if (Object.keys(changes).length === 0 && removeIds.length === 0 && reprices.length === 0 && toAdd.length === 0) {
      return { saleId: id, version: data.expectedVersion, changed: false };
    }
    // Parcelas (C52): total, pagamento, quantidade ou data mudam → cronograma
    // refeito; com parcela paga, a alteração inteira é recusada antes de gravar.
    const reschedule =
      changes.totalCents !== undefined ||
      changes.paymentMethod !== undefined ||
      changes.installmentCount !== undefined ||
      changes.saleDate !== undefined;
    if (reschedule) await assertScheduleChangeable(tx, id);
    if (Object.keys(changes).length > 0) await tx.update(sales).set(changes).where(eq(sales.id, id));
    if (removeIds.length > 0) {
      await tx.update(saleItems).set({ removedAt: sql`now()`, removedBy: actor.userId }).where(inArray(saleItems.id, removeIds));
    }
    // Correção de preço no próprio item: o banco preserva custo e comissão e
    // guarda o preço anterior para o UPDATED (itemsRepriced).
    for (const reprice of reprices) {
      await tx.update(saleItems).set({ priceCents: reprice.priceCents }).where(eq(saleItems.id, reprice.itemId));
    }
    if (toAdd.length > 0) {
      await tx.insert(saleItems).values(
        toAdd.map((item) => ({
          saleId: id,
          courseId: item.courseId,
          priceCents: item.priceCents,
          costSnapshotCents: costs.get(item.courseId)!,
          commissionSnapshotCents: BUSINESS_RULES.commissionPerItemCents,
          addedBy: actor.userId,
        })),
      );
    }
    if (reschedule) {
      await replaceInstallmentSchedule(tx, {
        id,
        status: sale.status,
        saleDate: changes.saleDate ?? sale.saleDate,
        totalCents: newTotal,
        paymentMethod,
        installmentCount,
      });
    }
    if (newSeller && sale.status === "ACTIVE") await applySaleToLead(tx, actor, lead, newSeller, id, "SALE_SELLER_CHANGED");
    // Por último: o banco calcula o antes/depois e o confere no COMMIT.
    const [event] = await tx.insert(saleEvents).values({ saleId: id, type: "UPDATED", actorId: actor.userId }).returning({ id: saleEvents.id });
    return { saleId: id, version: event.id, changed: true };
  });
}

/**
 * Estorna uma venda VÁLIDA (SUPERVISOR/ADMIN, no escopo), com motivo. A venda
 * continua existindo (itens e snapshots preservados), fora de faturamento,
 * comissão e ranking. Efeito no lead (planSaleReversal):
 *   - ainda há outra venda válida → continua em Fechamento, mesmo responsável;
 *   - última venda válida → Lead cadastrado, novo ciclo REOPENED, com o
 *     responsável atual se ele é ativo e da equipe do lead, ou na fila do
 *     supervisor se ele está inativo; outros casos são recusados até a troca
 *     do responsável da venda (sem regra confirmada).
 */
export async function reverseSale(ctx: ServiceContext, rawId: unknown, input: unknown): Promise<SaleReversalResult> {
  const { db, actor } = ctx;
  assertPermission(actor, "sales:reverse");
  const id = parseInput(idSchema, rawId);
  const { expectedVersion, reason } = parseInput(statusChangeSchema, input);

  return runTransaction(db, async (tx) => {
    const { lead, sale } = await lockSaleForChange(tx, actor, id, expectedVersion, []);
    if (sale.status !== "ACTIVE") throw new ValidationError(SALE_ALREADY_REVERSED);
    // Estável: toda criação/mudança de status de venda deste lead trava o lead antes.
    const [{ others }] = await tx
      .select({ others: count() })
      .from(sales)
      .where(and(eq(sales.leadId, sale.leadId), eq(sales.status, "ACTIVE"), ne(sales.id, id)));
    const plan = await planSaleReversal(tx, lead, others);

    await tx.update(sales).set({ status: "REVERSED" }).where(eq(sales.id, id));
    await cancelOpenInstallments(tx, id); // C52: as pagas continuam pagas
    await applySaleReversalToLead(tx, actor, lead, id, plan);
    const [event] = await tx
      .insert(saleEvents)
      .values({ saleId: id, type: "REVERSED", actorId: actor.userId, reason })
      .returning({ id: saleEvents.id });
    return { saleId: id, version: event.id, changed: true, leadOutcome: plan.kind };
  });
}

/**
 * Reativa uma venda ESTORNADA (SUPERVISOR/ADMIN, no escopo), com motivo.
 * Exige responsável SELLER ativo, com equipe ATIVA (senão: trocar o
 * responsável antes, por updateSale) e lead fora da Lixeira (recuperar antes;
 * nada é recuperado automaticamente). A venda volta a ser válida e o lead vai
 * (ou continua) em Fechamento, com o responsável da venda (SALE_REACTIVATED).
 */
export async function reactivateSale(ctx: ServiceContext, rawId: unknown, input: unknown): Promise<SaleChangeResult> {
  const { db, actor } = ctx;
  assertPermission(actor, "sales:reactivate");
  const id = parseInput(idSchema, rawId);
  const { expectedVersion, reason } = parseInput(statusChangeSchema, input);

  return runTransaction(db, async (tx) => {
    const { lead, sale } = await lockSaleForChange(tx, actor, id, expectedVersion, []);
    if (sale.status !== "REVERSED") throw new ValidationError(SALE_ALREADY_ACTIVE);
    if (lead.status !== "ACTIVE") throw new ValidationError(LEAD_IN_TRASH_REACTIVATE);
    let seller: Awaited<ReturnType<typeof loadSaleSeller>>;
    try {
      seller = await loadSaleSeller(tx, actor, sale.sellerId);
    } catch (error) {
      if (error instanceof ValidationError) throw new ValidationError(RESPONSIBLE_INVALID_REACTIVATE);
      throw error;
    }

    await tx.update(sales).set({ status: "ACTIVE" }).where(eq(sales.id, id));
    await reopenCanceledInstallments(tx, id); // C52
    await applySaleToLead(tx, actor, lead, seller, id, "SALE_REACTIVATED");
    const [event] = await tx
      .insert(saleEvents)
      .values({ saleId: id, type: "REACTIVATED", actorId: actor.userId, reason })
      .returning({ id: saleEvents.id });
    return { saleId: id, version: event.id, changed: true };
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const responsible = alias(users, "sale_responsible");
const historicalSupervisor = alias(users, "sale_supervisor");
const creator = alias(users, "sale_creator");

/** Escopo: o "time" do SUPERVISOR é a equipe ATUAL do vendedor responsável. */
function saleScope(actor: Actor): SQL | undefined {
  return ownedScope(actor, { ownerId: sales.sellerId, teamId: responsible.teamId });
}

const currentItems = and(eq(saleItems.saleId, sales.id), isNull(saleItems.removedAt));

const saleListView = {
  id: sales.id,
  leadId: sales.leadId,
  leadName: leads.name,
  sellerId: sales.sellerId,
  sellerName: responsible.name,
  teamId: sales.teamId,
  teamName: teams.name,
  saleDate: sales.saleDate,
  totalCents: sales.totalCents,
  paymentMethod: sales.paymentMethod,
  installmentCount: sales.installmentCount,
  status: sales.status,
  createdAt: sales.createdAt,
};

function selectSales(db: Database) {
  return db
    .select({
      ...saleListView,
      itemCount: sql<number>`(select count(*) from ${saleItems} where ${currentItems})`.mapWith(Number),
      courseNames: sql<string>`coalesce((select string_agg(c.name, ', ' order by i.added_at, i.id)
        from sale_items i join courses c on c.id = i.course_id
        where i.sale_id = ${sales.id} and i.removed_at is null), '')`,
    })
    .from(sales)
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .innerJoin(leads, eq(leads.id, sales.leadId))
    .innerJoin(teams, eq(teams.id, sales.teamId));
}

/**
 * Listagem paginada no banco: escopo e filtros no mesmo WHERE (filtrar por
 * vendedor/equipe fora do escopo devolve vazio); a contagem usa as mesmas
 * condições.
 */
export async function listSales({ db, actor }: ServiceContext, rawFilters: unknown = {}): Promise<Paginated<SaleListEntry>> {
  assertPermission(actor, "sales:view");
  const filters = parseInput(listFiltersSchema, rawFilters);
  const where = saleListConditions(actor, filters);

  const [{ total }] = await db
    .select({ total: count() })
    .from(sales)
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .innerJoin(leads, eq(leads.id, sales.leadId))
    .where(where);
  const pageSize = filters.pageSize ?? SALE_PAGE_SIZES[0];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(filters.page ?? 1, totalPages);
  const items =
    total === 0
      ? []
      : await selectSales(db)
          .where(where)
          .orderBy(desc(sales.saleDate), desc(sales.createdAt), desc(sales.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
  // Só vendas desta página, já filtradas pelo escopo acima.
  const reversals = await lastReversals(db, items.filter((item) => item.status === "REVERSED").map((item) => item.id));
  return { items: items.map((item) => ({ ...item, lastReversal: reversals.get(item.id) ?? null })), page, pageSize, total, totalPages };
}

/**
 * Escopo + filtros da listagem de vendas (exige `responsible` e `leads` no
 * FROM). Usado pela lista e pelos relatórios, para que os dois vejam sempre o
 * mesmo conjunto de vendas.
 */
function saleListConditions(actor: Actor, filters: z.output<typeof listFiltersSchema>): SQL | undefined {
  const conditions: (SQL | undefined)[] = [saleScope(actor)];
  if (filters.status) conditions.push(eq(sales.status, filters.status));
  if (filters.sellerId) conditions.push(eq(sales.sellerId, filters.sellerId));
  // Equipe ATUAL do vendedor responsável (C50); `sales.team_id` é só histórico.
  if (filters.teamId) conditions.push(eq(responsible.teamId, filters.teamId));
  if (filters.leadId) conditions.push(eq(sales.leadId, filters.leadId));
  if (filters.paymentMethod) conditions.push(eq(sales.paymentMethod, filters.paymentMethod));
  if (filters.dateFrom) conditions.push(gte(sales.saleDate, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(sales.saleDate, filters.dateTo));
  if (filters.search) conditions.push(ilike(leads.name, `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`));
  return and(...conditions);
}

export type SaleItemReportRow = {
  saleId: string;
  saleDate: string;
  status: SaleStatus;
  leadName: string;
  sellerId: string;
  sellerName: string;
  /** Equipe registrada na venda (histórico). */
  teamName: string;
  courseName: string;
  institutionName: string;
  priceCents: number;
  commissionSnapshotCents: number;
  /** Somente com `finance:viewCostAndProfit`. */
  costSnapshotCents?: number;
};

/**
 * Itens ATUAIS (não removidos) das vendas da listagem — mesmo escopo e mesmos
 * filtros de listSales (sem paginação; `limit` é um teto técnico). O custo de
 * bolsa só é lido para quem tem `finance:viewCostAndProfit`.
 */
export async function listSaleItemsForReport(
  { db, actor }: ServiceContext,
  rawFilters: unknown,
  limit: number,
): Promise<SaleItemReportRow[]> {
  assertPermission(actor, "sales:view");
  const filters = parseInput(listFiltersSchema, rawFilters);
  const withCost = hasPermission(actor, "finance:viewCostAndProfit");
  const rows = await db
    .select({
      saleId: sales.id,
      saleDate: sales.saleDate,
      status: sales.status,
      leadName: leads.name,
      sellerId: sales.sellerId,
      sellerName: responsible.name,
      teamName: teams.name,
      courseName: courses.name,
      institutionName: courses.institutionName,
      priceCents: saleItems.priceCents,
      commissionSnapshotCents: saleItems.commissionSnapshotCents,
      ...(withCost ? { costSnapshotCents: saleItems.costSnapshotCents } : {}),
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .innerJoin(leads, eq(leads.id, sales.leadId))
    .innerJoin(teams, eq(teams.id, sales.teamId))
    .innerJoin(courses, eq(courses.id, saleItems.courseId))
    .where(and(isNull(saleItems.removedAt), saleListConditions(actor, filters)))
    .orderBy(desc(sales.saleDate), desc(sales.createdAt), desc(sales.id), asc(saleItems.addedAt), asc(saleItems.id))
    .limit(limit);
  return rows;
}

/**
 * Custo das bolsas de cada venda informada (soma dos snapshots dos itens
 * atuais — a mesma regra de getSaleWithCost). Somente
 * `finance:viewCostAndProfit`; vendas fora do escopo não entram.
 */
export async function getSalesCostTotals(ctx: ServiceContext, saleIds: string[]): Promise<Map<string, number>> {
  assertPermission(ctx.actor, "finance:viewCostAndProfit");
  if (saleIds.length === 0) return new Map();
  const ids = parseInput(z.array(idSchema), saleIds);
  const rows = await ctx.db
    .select({ saleId: saleItems.saleId, costCents: sql<number>`coalesce(sum(${saleItems.costSnapshotCents}), 0)::bigint`.mapWith(Number) })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .where(and(inArray(saleItems.saleId, ids), isNull(saleItems.removedAt), saleScope(ctx.actor)))
    .groupBy(saleItems.saleId);
  return new Map(rows.map((row) => [row.saleId, row.costCents]));
}

/** Último evento REVERSED (maior id) de cada venda informada. Não altera nem apaga eventos. */
async function lastReversals(db: Database, saleIds: string[]): Promise<Map<string, SaleReversalInfo>> {
  if (saleIds.length === 0) return new Map();
  const reversalActor = alias(users, "sale_reversal_actor");
  const rows = await db
    .selectDistinctOn([saleEvents.saleId], {
      saleId: saleEvents.saleId,
      occurredAt: saleEvents.occurredAt,
      actorName: reversalActor.name,
      reason: saleEvents.reason,
    })
    .from(saleEvents)
    .innerJoin(reversalActor, eq(reversalActor.id, saleEvents.actorId))
    .where(and(inArray(saleEvents.saleId, saleIds), eq(saleEvents.type, "REVERSED")))
    .orderBy(saleEvents.saleId, desc(saleEvents.id));
  // O banco exige motivo em todo REVERSED (sale_events_reason_required).
  return new Map(rows.map((row) => [row.saleId, { occurredAt: row.occurredAt, actorName: row.actorName, reason: row.reason ?? "" }]));
}

/** Venda no escopo do ator, SEM custos de bolsa. Fora do escopo → NotFound. */
export async function getSale(ctx: ServiceContext, rawId: unknown): Promise<SaleView> {
  assertPermission(ctx.actor, "sales:view");
  const id = parseInput(idSchema, rawId);
  const { items, ...sale } = await loadSale(ctx, id);
  return {
    ...sale,
    items: items.map((item) => ({
      id: item.id,
      courseId: item.courseId,
      courseName: item.courseName,
      institutionName: item.institutionName,
      priceCents: item.priceCents,
      commissionSnapshotCents: item.commissionSnapshotCents,
      addedAt: item.addedAt,
    })),
  };
}

/** Venda COM os custos de bolsa dos itens (snapshot). Somente `finance:viewCostAndProfit`. */
export async function getSaleWithCost(ctx: ServiceContext, rawId: unknown): Promise<SaleWithCost> {
  assertPermission(ctx.actor, "finance:viewCostAndProfit");
  const id = parseInput(idSchema, rawId);
  const sale = await loadSale(ctx, id);
  const costTotalCents = sale.items.reduce((sum, item) => sum + item.costSnapshotCents, 0);
  return { ...sale, costTotalCents, profitTotalCents: sale.totalCents - costTotalCents };
}

async function loadSale({ db, actor }: ServiceContext, id: string): Promise<Omit<SaleView, "items"> & { items: SaleItemWithCost[] }> {
  const [sale] = await db
    .select({
      ...saleListView,
      supervisorName: historicalSupervisor.name,
      createdByName: creator.name,
      updatedAt: sales.updatedAt,
      version: sql<number>`(select max(${saleEvents.id}) from ${saleEvents} where ${saleEvents.saleId} = ${sales.id})`.mapWith(Number),
    })
    .from(sales)
    .innerJoin(responsible, eq(responsible.id, sales.sellerId))
    .innerJoin(leads, eq(leads.id, sales.leadId))
    .innerJoin(teams, eq(teams.id, sales.teamId))
    .innerJoin(creator, eq(creator.id, sales.createdBy))
    .leftJoin(historicalSupervisor, eq(historicalSupervisor.id, sales.supervisorId))
    .where(and(eq(sales.id, id), saleScope(actor)))
    .limit(1);
  if (!sale) throw new NotFoundError();

  const items = await db
    .select({
      id: saleItems.id,
      courseId: saleItems.courseId,
      courseName: courses.name,
      institutionName: courses.institutionName,
      priceCents: saleItems.priceCents,
      commissionSnapshotCents: saleItems.commissionSnapshotCents,
      costSnapshotCents: saleItems.costSnapshotCents,
      profitCents: sql<number>`${saleItems.priceCents} - ${saleItems.costSnapshotCents}`.mapWith(Number),
      addedAt: saleItems.addedAt,
    })
    .from(saleItems)
    .innerJoin(courses, eq(courses.id, saleItems.courseId))
    .where(and(eq(saleItems.saleId, id), isNull(saleItems.removedAt)))
    .orderBy(asc(saleItems.addedAt), asc(saleItems.id));

  return { ...sale, items, commissionTotalCents: items.reduce((sum, item) => sum + item.commissionSnapshotCents, 0) };
}

/**
 * Histórico da venda (sale_events), para quem vê a venda. O metadata é o do
 * banco, sem os custos de bolsa dos itens para quem não tem
 * `finance:viewCostAndProfit`. Controle técnico (txid) não sai do serviço.
 */
export async function getSaleHistory(ctx: ServiceContext, rawId: unknown): Promise<SaleHistoryEntry[]> {
  const sale = await getSale(ctx, rawId);
  const canSeeCost = hasPermission(ctx.actor, "finance:viewCostAndProfit");
  const eventActor = alias(users, "sale_event_actor");
  const rows = await ctx.db
    .select({
      id: saleEvents.id,
      type: saleEvents.type,
      occurredAt: saleEvents.occurredAt,
      actorName: eventActor.name,
      reason: saleEvents.reason,
      metadata: saleEvents.metadata,
    })
    .from(saleEvents)
    .innerJoin(eventActor, eq(eventActor.id, saleEvents.actorId))
    .where(eq(saleEvents.saleId, sale.id))
    .orderBy(asc(saleEvents.id));
  return rows.map((row) => ({ ...row, metadata: canSeeCost ? row.metadata : withoutCosts(row.metadata) }));
}

/** Remove, em qualquer profundidade, os custos de bolsa (costSnapshotCents). */
export function withoutCosts<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutCosts) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "costSnapshotCents").map(([key, v]) => [key, withoutCosts(v)]),
    ) as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Apoio à interface (somente leitura)
// ---------------------------------------------------------------------------

export type SaleSellerOption = { id: string; name: string; teamId: string; teamName: string };

/**
 * Vendedores que o ator pode escolher como responsável (as mesmas regras de
 * loadSaleSeller, que continua sendo a validação de fato): SELLER ativo de
 * equipe ATIVA; o SELLER-ator só a si e aos colegas da equipe atual dele.
 */
export async function listSaleSellerOptions({ db, actor }: ServiceContext): Promise<SaleSellerOption[]> {
  assertPermission(actor, "sales:create");
  const conditions: (SQL | undefined)[] = [eq(users.role, "SELLER"), eq(users.active, true), isNotNull(users.teamId), eq(teams.active, true)];
  if (actor.role === "SELLER") {
    const [me] = await db.select({ teamId: users.teamId }).from(users).where(eq(users.id, actor.userId)).limit(1);
    if (!me?.teamId) return [];
    conditions.push(eq(users.teamId, me.teamId));
  }
  const rows = await db
    .select({ id: users.id, name: users.name, teamId: teams.id, teamName: teams.name })
    .from(users)
    .innerJoin(teams, eq(teams.id, users.teamId))
    .where(and(...conditions))
    .orderBy(asc(teams.name), asc(users.name));
  return rows;
}

export type SaleHistoryView = {
  entries: SaleHistoryEntry[];
  /** Nomes dos vendedores, supervisores, equipes e cursos citados no histórico. */
  names: Record<string, string>;
};

/** Histórico (getSaleHistory: escopo e custos já tratados) com os nomes para exibição. */
export async function getSaleHistoryView(ctx: ServiceContext, rawId: unknown): Promise<SaleHistoryView> {
  const entries = await getSaleHistory(ctx, rawId);
  const userIds = new Set<string>();
  const teamIds = new Set<string>();
  const courseIds = new Set<string>();
  const add = (set: Set<string>, value: unknown) => typeof value === "string" && set.add(value);
  for (const { metadata } of entries) {
    const sale = metadata.sale as Record<string, unknown> | undefined;
    if (sale) {
      add(userIds, sale.sellerId);
      add(userIds, sale.supervisorId);
      add(teamIds, sale.teamId);
    }
    const changes = (metadata.changes ?? {}) as Record<string, { from?: unknown; to?: unknown }>;
    for (const key of ["sellerId", "supervisorId"]) [changes[key]?.from, changes[key]?.to].forEach((v) => add(userIds, v));
    [changes.teamId?.from, changes.teamId?.to].forEach((v) => add(teamIds, v));
    for (const list of ["items", "itemsAdded", "itemsRemoved", "itemsRepriced"]) {
      for (const item of (metadata[list] ?? []) as { courseId?: unknown }[]) add(courseIds, item.courseId);
    }
  }
  const lookup = async (ids: Set<string>, table: typeof users | typeof teams | typeof courses) => {
    if (ids.size === 0) return [];
    return ctx.db.select({ id: table.id, name: table.name }).from(table).where(inArray(table.id, [...ids]));
  };
  const rows = (await Promise.all([lookup(userIds, users), lookup(teamIds, teams), lookup(courseIds, courses)])).flat();
  return { entries, names: Object.fromEntries(rows.map((r) => [r.id, r.name])) };
}
