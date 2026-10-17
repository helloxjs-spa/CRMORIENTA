import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { DatabaseHandle } from "@/server/db/connect";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { getMonthlyComparison, getSalesIndicators } from "@/server/modules/dashboard/dashboard.service";
import { createLead, getLeadIndicators } from "@/server/modules/leads/leads.service";
import { createSale, getSale, reverseSale, updateSale } from "@/server/modules/sales/sales.service";
import { changeSellerTeam } from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { setLeadStage } from "../support/leads";
import { insertCourseWithCost } from "../support/sales";

/**
 * Cenário (curso com custo de bolsa R$ 400, comissão R$ 100 por item):
 *   A1: L1 (2 vendas válidas em jul), L2 (venda estornada), L3, L7 — sem venda
 *   A2: L4 (venda de jul com 2 itens; 1 removido) e, já na equipe B, L6 (venda em jul)
 *   B1: L5 (venda em ago)
 * A2 muda da equipe A para a B depois da venda de L4: pela C50 o supervisor B
 * passa a ver também a venda antiga de L4 (sales.team_id continua A, só histórico).
 */
let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;

const JUL = { dateFrom: "2026-07-01", dateTo: "2026-07-31" };
const AUG = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };
const EMPTY = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };
/** Mês atual no fuso do negócio: os leads deste teste são cadastrados agora. */
const month = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone, year: "numeric", month: "2-digit" }).format(new Date());
const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const NOW = { dateFrom: `${month}-01`, dateTo: `${month}-${String(lastDay).padStart(2, "0")}` };

let seq = 0;
const nextPhone = () => `(79) 91${String(++seq).padStart(7, "0")}`;
const ctx = (userId: string) => org.ctx(userId);

async function lead(sellerId: string): Promise<string> {
  return (await createLead(await ctx(sellerId), { name: `Cliente Painel ${seq}`, phone: nextPhone(), interestCourseId: course })).id;
}
/** Venda registrada pelo ADMIN (que informa a data). */
async function sale(leadId: string, sellerId: string, saleDate: string, prices: number[]): Promise<string> {
  const items = prices.map((priceCents) => ({ courseId: course, priceCents }));
  const input = { requestId: crypto.randomUUID(), leadId, sellerId, saleDate, paymentMethod: "PIX", items };
  return (await createSale(await ctx(org.ids.admin), input)).saleId;
}

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);
  const admin = await ctx(org.ids.admin);

  const [l1, l2, l3, l7] = [await lead(org.ids.sellerA1), await lead(org.ids.sellerA1), await lead(org.ids.sellerA1), await lead(org.ids.sellerA1)];
  const l4 = await lead(org.ids.sellerA2);
  const l5 = await lead(org.ids.sellerB1);

  await sale(l1, org.ids.sellerA1, "2026-07-10", [100_000]);
  await sale(l1, org.ids.sellerA1, "2026-07-20", [200_000]);
  const reversed = await sale(l2, org.ids.sellerA1, "2026-07-15", [300_000]);
  await reverseSale(admin, reversed, { expectedVersion: (await getSale(admin, reversed)).version, reason: "Desistência" });

  const twoItems = await sale(l4, org.ids.sellerA2, "2026-07-05", [150_000, 50_000]);
  const loaded = await getSale(admin, twoItems);
  const removed = loaded.items.find((item) => item.priceCents === 50_000)!;
  await updateSale(await ctx(org.ids.supA), twoItems, { expectedVersion: loaded.version, removeItemIds: [removed.id] });

  await sale(l5, org.ids.sellerB1, "2026-08-03", [500_000]);

  // A2 vai para a equipe B: a venda de L4 continua na A; a próxima já é da B.
  await changeSellerTeam(admin, org.ids.sellerA2, { teamId: org.ids.teamB });
  const l6 = await lead(org.ids.sellerA2);
  await sale(l6, org.ids.sellerA2, "2026-07-25", [80_000]);

  // Alertas (por último: negociação vencida bloqueia o vendedor de cadastrar).
  await setLeadStage(handle, l2, "FOLLOW_UP_1", -1);
  await setLeadStage(handle, l3, "NEGOTIATION", -1);
  await setLeadStage(handle, l7, "FOLLOW_UP_3", -1);
});
afterAll(() => handle.close());

describe("vendas: válidas, pela data da venda, com itens removidos fora", () => {
  it("ADMIN: totais globais, comissão e custo só dos itens atuais, lucro = faturamento − custo", async () => {
    expect(await getSalesIndicators(await ctx(org.ids.admin), JUL)).toEqual({
      salesCount: 4,
      revenueCents: 530_000,
      commissionCents: 40_000,
      finance: { costCents: 160_000, profitCents: 370_000 },
    });
    expect(await getSalesIndicators(await ctx(org.ids.admin), AUG)).toEqual({
      salesCount: 1,
      revenueCents: 500_000,
      commissionCents: 10_000,
      finance: { costCents: 40_000, profitCents: 460_000 },
    });
  });

  it("SUPERVISOR: vendedores atuais da equipe, com as vendas anteriores à transferência (C50); sem custo nem lucro", async () => {
    // A2 foi para a B: a venda de L4 (registrada na A) passa para o escopo da B.
    const supA = await getSalesIndicators(await ctx(org.ids.supA), JUL);
    expect(supA).toEqual({ salesCount: 2, revenueCents: 300_000, commissionCents: 20_000 });
    expect(await getSalesIndicators(await ctx(org.ids.supB), JUL)).toEqual({ salesCount: 2, revenueCents: 230_000, commissionCents: 20_000 });
    expect(JSON.stringify(supA)).not.toMatch(/cost|profit|finance|margin/i);
  });

  it("SELLER: só as vendas de que é responsável; estornada não conta; sem custo nem lucro", async () => {
    expect(await getSalesIndicators(await ctx(org.ids.sellerA1), JUL)).toEqual({ salesCount: 2, revenueCents: 300_000, commissionCents: 20_000 });
    expect(await getSalesIndicators(await ctx(org.ids.sellerA2), JUL)).toEqual({ salesCount: 2, revenueCents: 230_000, commissionCents: 20_000 });
    expect(await getSalesIndicators(await ctx(org.ids.sellerB1), JUL)).toEqual({ salesCount: 0, revenueCents: 0, commissionCents: 0 });
  });

  it("período inválido é recusado", async () => {
    await expect(getSalesIndicators(await ctx(org.ids.admin), { dateFrom: "2026-07-31", dateTo: "2026-07-01" })).rejects.toBeInstanceOf(ValidationError);
    await expect(getSalesIndicators(await ctx(org.ids.admin), { ...JUL, teamId: org.ids.teamA })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("leads: cadastrados no período × carteira atual × conversão", () => {
  it("conversão conta cada lead uma vez (L1 comprou 2x) e ignora venda estornada (L2)", async () => {
    expect(await getLeadIndicators(await ctx(org.ids.sellerA1), NOW)).toMatchObject({ createdInPeriod: 4, convertedInPeriod: 1, conversionRate: 25 });
    // Escopo atual de leads (o de listLeads). Na troca de equipe só os leads em
    // aberto acompanham o vendedor (C4): L4, em Fechamento, continua na equipe A.
    expect(await getLeadIndicators(await ctx(org.ids.supA), NOW)).toMatchObject({ createdInPeriod: 5, convertedInPeriod: 2, conversionRate: 40 });
    expect(await getLeadIndicators(await ctx(org.ids.supB), NOW)).toMatchObject({ createdInPeriod: 2, convertedInPeriod: 2, conversionRate: 100 });
    const admin = await getLeadIndicators(await ctx(org.ids.admin), NOW);
    expect(admin).toMatchObject({ createdInPeriod: 7, convertedInPeriod: 4 });
    expect(admin.conversionRate).toBeCloseTo(57.142857, 5);
  });

  it("sem leads cadastrados no período: conversão indisponível (null), não 0%", async () => {
    expect(await getLeadIndicators(await ctx(org.ids.admin), EMPTY)).toMatchObject({ createdInPeriod: 0, convertedInPeriod: 0, conversionRate: null });
  });

  it("carteira atual por etapa independe do período", async () => {
    const a1 = await getLeadIndicators(await ctx(org.ids.sellerA1), EMPTY);
    const counts = Object.fromEntries(a1.portfolio.map((p) => [p.stage, p.count]));
    expect(counts).toMatchObject({ CLOSED: 1, FOLLOW_UP_1: 1, NEGOTIATION: 1, FOLLOW_UP_3: 1, NEW: 0 });
    expect(a1.portfolio.map((p) => p.stage)[0]).toBe("NEW");
  });

  it("alertas no escopo: vendedor sem fila de decisão; supervisor com Follow-up 3 vencido", async () => {
    expect((await getLeadIndicators(await ctx(org.ids.sellerA1), NOW)).alerts).toEqual({
      followUpsOverdue: 2,
      negotiationsOverdue: 1,
      awaitingDecision: null,
    });
    expect((await getLeadIndicators(await ctx(org.ids.supA), NOW)).alerts).toEqual({
      followUpsOverdue: 2,
      negotiationsOverdue: 1,
      awaitingDecision: { unassigned: 0, followUp3Expired: 1 },
    });
    expect((await getLeadIndicators(await ctx(org.ids.supB), NOW)).alerts).toMatchObject({ followUpsOverdue: 0, negotiationsOverdue: 0 });
  });
});

describe("comparação mês a mês (ADMIN)", () => {
  it("12 meses até o mês final, com variação e 'sem base' quando o mês anterior é zero", async () => {
    const rows = await getMonthlyComparison(await ctx(org.ids.admin), { endMonth: "2026-08" });
    expect(rows).toHaveLength(12);
    expect(rows[0].month).toBe("2025-09");
    expect(rows.at(-1)!.month).toBe("2026-08");

    const jul = rows.find((r) => r.month === "2026-07")!;
    expect(jul).toMatchObject({ salesCount: 4, revenueCents: 530_000, costCents: 160_000, profitCents: 370_000 });
    expect(jul.change).toEqual({ salesCount: null, revenueCents: null, costCents: null, profitCents: null });

    const aug = rows.at(-1)!;
    expect(aug).toMatchObject({ salesCount: 1, revenueCents: 500_000, costCents: 40_000, profitCents: 460_000 });
    expect(aug.change.salesCount).toBe(-75);
    expect(aug.change.revenueCents).toBeCloseTo(-5.660377, 5);
    expect(aug.change.costCents).toBe(-75);
    expect(aug.change.profitCents).toBeCloseTo(24.324324, 5);
    expect(rows.find((r) => r.month === "2026-01")).toMatchObject({ salesCount: 0, revenueCents: 0, change: { revenueCents: null } });
  });

  it("SUPERVISOR e SELLER não acessam (custo e lucro)", async () => {
    for (const userId of [org.ids.supA, org.ids.sellerA1]) {
      await expect(getMonthlyComparison(await ctx(userId), { endMonth: "2026-08" })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("mês inválido é recusado", async () => {
    await expect(getMonthlyComparison(await ctx(org.ids.admin), { endMonth: "2026-13" })).rejects.toBeInstanceOf(ValidationError);
  });
});

// Por último: cria vendas e leads novos que os cenários acima não consideram.
describe("vendedor sem equipe atual (C50)", () => {
  it("ADMIN mantém as vendas nos totais globais; nenhum supervisor as vê; o vendedor vê as próprias", async () => {
    const MAR = { dateFrom: "2026-03-01", dateTo: "2026-03-31" };
    const loose = await insertUser(handle, { name: "Vendedor Sem Equipe Painel", role: "SELLER", teamId: org.ids.teamB });
    await sale(await lead(loose), loose, "2026-03-10", [60_000]);
    await changeSellerTeam(await ctx(org.ids.admin), loose, { teamId: null });

    expect(await getSalesIndicators(await ctx(org.ids.admin), MAR)).toEqual({
      salesCount: 1,
      revenueCents: 60_000,
      commissionCents: 10_000,
      finance: { costCents: 40_000, profitCents: 20_000 },
    });
    for (const supervisor of [org.ids.supA, org.ids.supB]) {
      expect(await getSalesIndicators(await ctx(supervisor), MAR)).toEqual({ salesCount: 0, revenueCents: 0, commissionCents: 0 });
    }
    expect(await getSalesIndicators(await ctx(loose), MAR)).toEqual({ salesCount: 1, revenueCents: 60_000, commissionCents: 10_000 });
  });
});
