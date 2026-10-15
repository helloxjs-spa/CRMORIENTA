import { and, eq, gte, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { RANKING_CRITERIA, RANKING_VIEWS, rankEntries, type Ranked, type RankingCriterion } from "@/lib/ranking";
import { assertPermission } from "@/server/authz/permissions";
import { managedTeamScope } from "@/server/authz/scope";
import type { ServiceContext } from "@/server/context";
import { sales, teams, users } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { ForbiddenError } from "@/server/errors";
import { parseInput } from "@/server/validation";

/**
 * Ranking (§16), só leitura, calculado no banco a partir das vendas VÁLIDAS
 * (`status = ACTIVE`) com `sale_date` no período. Estornadas não contam.
 *
 * - Vendedores: agrupados pelo responsável da venda (`sales.seller_id`).
 * - Equipes: pela equipe da venda na época (`sales.team_id`, C4) — mudar o
 *   vendedor de equipe não reatribui vendas antigas.
 * - Participam só vendedores/equipes com venda válida no período (C43);
 *   empate = mesma posição (C44).
 *
 * Visibilidade (C42), aplicada aqui no servidor:
 * - ADMIN: vendedores da empresa e equipes, completos.
 * - SUPERVISOR: vendedores das vendas da equipe que lidera e ranking das equipes.
 * - SELLER: somente a própria posição no ranking geral de vendedores ("3º de 25");
 *   nenhum nome, quantidade ou valor de colega sai do serviço.
 */

export const RANKING_PERIOD_INVERTED = "A data inicial deve ser igual ou anterior à final.";

const rankingInputSchema = z
  .strictObject({
    view: z.enum(RANKING_VIEWS, { error: "Visão inválida." }),
    criterion: z.enum(RANKING_CRITERIA, { error: "Critério inválido." }),
    dateFrom: z.iso.date({ error: "Data inválida." }),
    dateTo: z.iso.date({ error: "Data inválida." }),
  })
  .refine((value) => value.dateFrom <= value.dateTo, { path: ["dateTo"], message: RANKING_PERIOD_INVERTED });

type RankingInput = z.output<typeof rankingInputSchema>;

export type SellerRankingEntry = Ranked<{ id: string; name: string; active: boolean; salesCount: number; revenueCents: number }>;
export type TeamRankingEntry = Ranked<{
  id: string;
  name: string;
  active: boolean;
  supervisorName: string | null;
  salesCount: number;
  revenueCents: number;
}>;

export type RankingResult =
  | {
      mode: "self";
      criterion: RankingCriterion;
      /** null = sem venda válida no período (fora do ranking). */
      position: number | null;
      tied: boolean;
      /** Vendedores com venda válida no período (o "N" de "Xº de N"). */
      total: number;
      salesCount: number;
      revenueCents: number;
    }
  | { mode: "sellers"; criterion: RankingCriterion; scope: "company" | "team"; entries: SellerRankingEntry[] }
  | { mode: "teams"; criterion: RankingCriterion; entries: TeamRankingEntry[] };

const supervisor = alias(users, "ranking_supervisor");

const validInPeriod = (data: RankingInput) =>
  and(eq(sales.status, "ACTIVE"), gte(sales.saleDate, data.dateFrom), lte(sales.saleDate, data.dateTo));

const totals = {
  salesCount: sql<number>`count(*)::int`,
  revenueCents: sql<number>`coalesce(sum(${sales.totalCents}), 0)::bigint`.mapWith(Number),
};

async function sellerTotals(db: Database, data: RankingInput, teamScope: ReturnType<typeof managedTeamScope>) {
  return db
    .select({ id: sales.sellerId, name: users.name, active: users.active, ...totals })
    .from(sales)
    .innerJoin(users, eq(users.id, sales.sellerId))
    .where(and(validInPeriod(data), teamScope))
    .groupBy(sales.sellerId, users.name, users.active);
}

async function teamTotals(db: Database, data: RankingInput) {
  return db
    .select({ id: sales.teamId, name: teams.name, active: teams.active, supervisorName: supervisor.name, ...totals })
    .from(sales)
    .innerJoin(teams, eq(teams.id, sales.teamId))
    .leftJoin(supervisor, eq(supervisor.id, teams.supervisorId))
    .where(validInPeriod(data))
    .groupBy(sales.teamId, teams.name, teams.active, supervisor.name);
}

export async function getRanking({ db, actor }: ServiceContext, input: unknown): Promise<RankingResult> {
  assertPermission(actor, "ranking:view");
  const data = parseInput(rankingInputSchema, input);
  const { criterion } = data;

  if (actor.role === "SELLER") {
    // Só a própria posição no ranking geral; equipes e colegas não são expostos.
    if (data.view !== "sellers") throw new ForbiddenError();
    const ranked = rankEntries(await sellerTotals(db, data, undefined), criterion);
    const own = ranked.find((entry) => entry.id === actor.userId);
    return {
      mode: "self",
      criterion,
      position: own?.position ?? null,
      tied: own?.tied ?? false,
      total: ranked.length,
      salesCount: own?.salesCount ?? 0,
      revenueCents: own?.revenueCents ?? 0,
    };
  }

  if (data.view === "teams") {
    return { mode: "teams", criterion, entries: rankEntries(await teamTotals(db, data), criterion) };
  }

  // ADMIN: sem restrição; SUPERVISOR: vendas da equipe que lidera (equipe da
  // época); supervisor sem equipe não vê vendedores.
  const scope = managedTeamScope(actor, sales.teamId);
  return {
    mode: "sellers",
    criterion,
    scope: actor.role === "ADMIN" ? "company" : "team",
    entries: rankEntries(await sellerTotals(db, data, scope), criterion),
  };
}
