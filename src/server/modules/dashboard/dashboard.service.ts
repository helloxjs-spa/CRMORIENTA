import { and, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { lastMonths, percentChange } from "@/lib/dashboard";
import { isValidMonth, monthRange } from "@/lib/ranking";
import type { Actor } from "@/server/authz/actor";
import { assertPermission, hasPermission } from "@/server/authz/permissions";
import { managedTeamScope } from "@/server/authz/scope";
import type { ServiceContext } from "@/server/context";
import { saleItems, sales, users } from "@/server/db/schema";
import { parseInput } from "@/server/validation";

/**
 * Dashboard comercial (§17): indicadores de vendas, só leitura.
 *
 * - Só vendas VÁLIDAS (`status = ACTIVE`), pela data da venda (`sale_date`).
 *   Faturamento = soma de `sales.total_cents` (valor vendido, não parcelas
 *   recebidas); o banco garante que ele é a soma dos preços dos itens atuais.
 * - Comissão = soma de `commission_snapshot_cents` dos itens atuais (não
 *   removidos) — a mesma regra do detalhe da venda (§14, R$ 100 por curso).
 * - Custo = soma de `cost_snapshot_cents` dos itens atuais; Lucro = faturamento
 *   − custo (§13; comissão não entra). Somente `finance:viewCostAndProfit`
 *   (ADMIN): para os demais, custo e lucro nem são consultados.
 * - Escopo (C50): SELLER as vendas de que é responsável; SUPERVISOR as vendas
 *   dos vendedores ATUALMENTE na equipe que lidera (`users.team_id`), inclusive
 *   as anteriores a uma transferência — `sales.team_id` fica só como registro
 *   histórico; ADMIN todas (inclusive de vendedores sem equipe atual).
 */

const periodSchema = z
  .strictObject({ dateFrom: z.iso.date({ error: "Data inválida." }), dateTo: z.iso.date({ error: "Data inválida." }) })
  .refine((value) => value.dateFrom <= value.dateTo, { path: ["dateTo"], message: "A data inicial deve ser igual ou anterior à final." });

const monthSchema = z.strictObject({
  endMonth: z.string().refine(isValidMonth, { message: "Mês inválido." }),
});

export type SalesIndicators = {
  salesCount: number;
  revenueCents: number;
  commissionCents: number;
  /** Presente somente para ADMIN (`finance:viewCostAndProfit`). */
  finance?: { costCents: number; profitCents: number };
};

export type MonthlyComparisonRow = {
  month: string;
  salesCount: number;
  revenueCents: number;
  costCents: number;
  profitCents: number;
  /** Variação % sobre o mês anterior; null = sem base comparável ("Indisponível"). */
  change: { salesCount: number | null; revenueCents: number | null; costCents: number | null; profitCents: number | null };
};

const COMPARISON_MONTHS = 12;

/** Exige `users` (responsável) no FROM, ligado por `sales.seller_id`. */
function salesScope(actor: Actor): SQL | undefined {
  if (actor.role === "SELLER") return eq(sales.sellerId, actor.userId);
  return managedTeamScope(actor, users.teamId);
}

const sumBigint = (column: SQL | typeof sales.totalCents) => sql<number>`coalesce(sum(${column}), 0)::bigint`.mapWith(Number);

export async function getSalesIndicators({ db, actor }: ServiceContext, input: unknown): Promise<SalesIndicators> {
  assertPermission(actor, "sales:view");
  const { dateFrom, dateTo } = parseInput(periodSchema, input);
  const where = and(eq(sales.status, "ACTIVE"), gte(sales.saleDate, dateFrom), lte(sales.saleDate, dateTo), salesScope(actor));
  const withFinance = hasPermission(actor, "finance:viewCostAndProfit");

  const [totals] = await db
    .select({ salesCount: sql<number>`count(*)::int`, revenueCents: sumBigint(sales.totalCents) })
    .from(sales)
    .innerJoin(users, eq(users.id, sales.sellerId))
    .where(where);
  const [items] = await db
    .select({
      commissionCents: sumBigint(sql`${saleItems.commissionSnapshotCents}`),
      // Custo só é lido para quem pode vê-lo.
      ...(withFinance ? { costCents: sumBigint(sql`${saleItems.costSnapshotCents}`) } : {}),
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .innerJoin(users, eq(users.id, sales.sellerId))
    .where(and(isNull(saleItems.removedAt), where));

  const result: SalesIndicators = { salesCount: totals.salesCount, revenueCents: totals.revenueCents, commissionCents: items.commissionCents };
  if (withFinance) {
    const costCents = (items as { costCents: number }).costCents;
    result.finance = { costCents, profitCents: totals.revenueCents - costCents };
  }
  return result;
}

/**
 * Comparação mês a mês (§17.3), somente ADMIN: os 12 meses até `endMonth`
 * (inclusive), com vendas válidas, faturamento, custo, lucro e a variação % de
 * cada um sobre o mês anterior (o 13º mês para trás serve só de base).
 */
export async function getMonthlyComparison({ db, actor }: ServiceContext, input: unknown): Promise<MonthlyComparisonRow[]> {
  assertPermission(actor, "finance:viewCostAndProfit");
  const { endMonth } = parseInput(monthSchema, input);
  const months = lastMonths(endMonth, COMPARISON_MONTHS + 1);
  const where = and(eq(sales.status, "ACTIVE"), gte(sales.saleDate, monthRange(months[0]).from), lte(sales.saleDate, monthRange(endMonth).to));
  const monthOf = sql<string>`to_char(${sales.saleDate}, 'YYYY-MM')`;

  const salesRows = await db
    .select({ month: monthOf, salesCount: sql<number>`count(*)::int`, revenueCents: sumBigint(sales.totalCents) })
    .from(sales)
    .where(where)
    .groupBy(monthOf);
  const costRows = await db
    .select({ month: monthOf, costCents: sumBigint(sql`${saleItems.costSnapshotCents}`) })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .where(and(isNull(saleItems.removedAt), where))
    .groupBy(monthOf);

  const bySales = new Map(salesRows.map((row) => [row.month, row]));
  const byCost = new Map(costRows.map((row) => [row.month, row.costCents]));
  const totals = months.map((month) => {
    const revenueCents = bySales.get(month)?.revenueCents ?? 0;
    const costCents = byCost.get(month) ?? 0;
    return { month, salesCount: bySales.get(month)?.salesCount ?? 0, revenueCents, costCents, profitCents: revenueCents - costCents };
  });

  return totals.slice(1).map((row, index) => {
    const previous = totals[index];
    return {
      ...row,
      change: {
        salesCount: percentChange(row.salesCount, previous.salesCount),
        revenueCents: percentChange(row.revenueCents, previous.revenueCents),
        costCents: percentChange(row.costCents, previous.costCents),
        profitCents: percentChange(row.profitCents, previous.profitCents),
      },
    };
  });
}
