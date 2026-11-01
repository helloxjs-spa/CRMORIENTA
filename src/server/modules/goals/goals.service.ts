import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { shiftMonth } from "@/lib/goals";
import { isValidMonth, monthRange } from "@/lib/ranking";
import { assertPermission, hasPermission } from "@/server/authz/permissions";
import { canManageTeam } from "@/server/authz/scope";
import type { ServiceContext } from "@/server/context";
import { isUniqueViolation } from "@/server/db/errors";
import { sales, salesGoals, teams, users } from "@/server/db/schema";
import { RetryTransactionError, runTransaction } from "@/server/db/transaction";
import { NotFoundError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { idSchema, parseInput } from "@/server/validation";

/**
 * Resultado do mês: faturamento × metas mensais (008).
 *
 * - Realizado = faturamento das vendas VÁLIDAS pela data da venda (a mesma
 *   regra do Dashboard §17), atribuído ao vendedor responsável ATUAL.
 * - Todos veem o time inteiro e cada vendedor (decisão do usuário em
 *   31/10/2026). Só faturamento: custo e lucro nunca entram aqui.
 * - Metas: uma geral por mês (ADMIN) e uma por vendedor (ADMIN; SUPERVISOR só
 *   para os vendedores atualmente na equipe que lidera). Retirar a meta grava
 *   NULL (sem exclusão física). Toda mudança é auditada na mesma transação.
 */

export type SellerResult = {
  sellerId: string;
  name: string;
  teamName: string | null;
  active: boolean;
  realizedCents: number;
  goalCents: number | null;
  /** O ator pode definir a meta deste vendedor. */
  canEditGoal: boolean;
};

export type MonthlyResult = {
  month: string;
  realizedCents: number;
  previousRealizedCents: number;
  generalGoalCents: number | null;
  canEditGeneralGoal: boolean;
  sellers: SellerResult[];
};

const monthSchema = z.string().refine(isValidMonth, { message: "Mês inválido." });

const sumRevenue = sql<number>`coalesce(sum(${sales.totalCents}), 0)::bigint`.mapWith(Number);

export async function getMonthlyResult({ db, actor }: ServiceContext, rawMonth: unknown): Promise<MonthlyResult> {
  assertPermission(actor, "goals:view");
  const month = parseInput(monthSchema, rawMonth);
  const { from, to } = monthRange(month);
  const previous = monthRange(shiftMonth(month, -1));
  const valid = (range: { from: string; to: string }) =>
    and(eq(sales.status, "ACTIVE"), gte(sales.saleDate, range.from), lte(sales.saleDate, range.to));

  const [bySeller, [prev], goals] = await Promise.all([
    db.select({ sellerId: sales.sellerId, realizedCents: sumRevenue }).from(sales).where(valid({ from, to })).groupBy(sales.sellerId),
    db.select({ realizedCents: sumRevenue }).from(sales).where(valid(previous)),
    db.select({ sellerId: salesGoals.sellerId, amountCents: salesGoals.amountCents }).from(salesGoals).where(eq(salesGoals.month, `${month}-01`)),
  ]);

  const realizedOf = new Map(bySeller.map((row) => [row.sellerId, row.realizedCents]));
  const goalOf = new Map(goals.filter((g) => g.sellerId && g.amountCents).map((g) => [g.sellerId!, g.amountCents!]));
  // Vendedores ativos + quem vendeu ou tinha meta no mês (mesmo se desativado depois).
  const relevant = [...realizedOf.keys(), ...goalOf.keys()];
  const sellerRows = await db
    .select({ id: users.id, name: users.name, active: users.active, teamId: users.teamId, teamName: teams.name })
    .from(users)
    .leftJoin(teams, eq(teams.id, users.teamId))
    .where(and(eq(users.role, "SELLER"), or(eq(users.active, true), relevant.length > 0 ? inArray(users.id, relevant) : undefined)))
    .orderBy(asc(users.name));

  const canSetSeller = hasPermission(actor, "goals:setSeller");
  const sellers = sellerRows
    .map(
      (seller): SellerResult => ({
        sellerId: seller.id,
        name: seller.name,
        teamName: seller.teamName,
        active: seller.active,
        realizedCents: realizedOf.get(seller.id) ?? 0,
        goalCents: goalOf.get(seller.id) ?? null,
        canEditGoal: canSetSeller && seller.active && canManageTeam(actor, seller.teamId),
      }),
    )
    .sort((a, b) => b.realizedCents - a.realizedCents || a.name.localeCompare(b.name, "pt-BR"));

  return {
    month,
    realizedCents: bySeller.reduce((sum, row) => sum + row.realizedCents, 0),
    previousRealizedCents: prev.realizedCents,
    generalGoalCents: goals.find((g) => g.sellerId === null)?.amountCents ?? null,
    canEditGeneralGoal: hasPermission(actor, "goals:setGeneral"),
    sellers,
  };
}

const setGoalSchema = z.strictObject({
  month: monthSchema,
  /** null = meta geral (time inteiro). */
  sellerId: idSchema.nullable(),
  /** null = retirar a meta. */
  amountCents: z
    .number({ error: "Informe um valor válido." })
    .int("Informe um valor válido.")
    .positive("A meta deve ser maior que zero.")
    .max(2_000_000_000, "Valor alto demais.")
    .nullable(),
});

/** Define, altera ou retira (amountCents null) a meta geral ou de um vendedor no mês. */
export async function setSalesGoal({ db, actor }: ServiceContext, input: unknown): Promise<void> {
  const { month, sellerId, amountCents } = parseInput(setGoalSchema, input);
  assertPermission(actor, sellerId ? "goals:setSeller" : "goals:setGeneral");

  await runTransaction(db, async (tx) => {
    let teamId: string | null = null;
    if (sellerId) {
      // Fora do escopo do supervisor (ou não é vendedor ativo): 404.
      const [seller] = await tx
        .select({ teamId: users.teamId })
        .from(users)
        .where(and(eq(users.id, sellerId), eq(users.role, "SELLER"), eq(users.active, true)))
        .for("share");
      if (!seller || !canManageTeam(actor, seller.teamId)) throw new NotFoundError();
      teamId = seller.teamId;
    }

    const target = and(eq(salesGoals.month, `${month}-01`), sellerId ? eq(salesGoals.sellerId, sellerId) : isNull(salesGoals.sellerId));
    const [existing] = await tx.select({ id: salesGoals.id, amountCents: salesGoals.amountCents }).from(salesGoals).where(target).for("update");
    const fromCents = existing?.amountCents ?? null;
    if (fromCents === amountCents) return; // nada muda

    let goalId: string;
    if (existing) {
      await tx.update(salesGoals).set({ amountCents, updatedBy: actor.userId, updatedAt: sql`now()` }).where(eq(salesGoals.id, existing.id));
      goalId = existing.id;
    } else {
      try {
        const [created] = await tx
          .insert(salesGoals)
          .values({ month: `${month}-01`, sellerId, amountCents, createdBy: actor.userId, updatedBy: actor.userId })
          .returning({ id: salesGoals.id });
        goalId = created.id;
      } catch (error) {
        // Outra pessoa criou a mesma meta ao mesmo tempo: refaz e atualiza a dela.
        if (isUniqueViolation(error, "sales_goals_general_month_unique") || isUniqueViolation(error, "sales_goals_seller_month_unique")) {
          throw new RetryTransactionError();
        }
        throw error;
      }
    }

    await recordAudit(tx, {
      actorId: actor.userId,
      action: "goal.set",
      entityType: "sales_goal",
      entityId: goalId,
      teamId,
      metadata: { month, sellerId, fromCents, toCents: amountCents },
    });
  });
}

