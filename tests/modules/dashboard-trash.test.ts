import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { DatabaseHandle } from "@/server/db/connect";
import { ValidationError } from "@/server/errors";
import { createLead, getLeadIndicators, trashLead } from "@/server/modules/leads/leads.service";
import { createSale } from "@/server/modules/sales/sales.service";
import { teams } from "@/server/db/schema";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { setLeadStage } from "../support/leads";
import { insertCourseWithCost, saleInput } from "../support/sales";

/**
 * Leads na Lixeira no Dashboard (decisão B):
 *   - fora dos indicadores operacionais (carteira, alertas, fila de decisão);
 *   - nos números do período de quem os enxerga (SUPERVISOR/ADMIN), identificados;
 *   - sem ampliar o escopo do SELLER.
 * Conversão (#28): denominador = leads cadastrados no período fora da Lixeira.
 * Equipe A (A1): L1 vendido, L2 negociação vencida → Lixeira, L3 Follow-up 3
 * vencido → Lixeira, L4 novo. Equipe B (B1), controle sem Lixeira: L5
 * negociação vencida, L6 Follow-up 3 vencido. Equipe C (C1): L7 → Lixeira
 * (nenhum lead elegível).
 */
let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let sold: string;
let supC: string;
let sellerC1: string;

const month = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone, year: "numeric", month: "2-digit" }).format(new Date());
const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const NOW = { dateFrom: `${month}-01`, dateTo: `${month}-${String(lastDay).padStart(2, "0")}` };

let seq = 0;
const nextPhone = () => `(79) 90${String(++seq).padStart(7, "0")}`;
const ctx = (userId: string) => org.ctx(userId);
const lead = async (sellerId: string) =>
  (await createLead(await ctx(sellerId), { name: `Cliente Lixeira ${seq}`, phone: nextPhone(), interestCourseId: course })).id;
const stageCounts = (portfolio: { stage: string; count: number }[]) => Object.fromEntries(portfolio.filter((p) => p.count > 0).map((p) => [p.stage, p.count]));

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);

  supC = await insertUser(handle, { name: "Supervisor C", role: "SUPERVISOR" });
  const [teamC] = await handle.db.insert(teams).values({ name: "Equipe C", supervisorId: supC }).returning({ id: teams.id });
  sellerC1 = await insertUser(handle, { name: "Vendedor C1", role: "SELLER", teamId: teamC.id });
  const onlyTrashed = await lead(sellerC1);

  sold = await lead(org.ids.sellerA1);
  const [negotiation, followUp3] = [await lead(org.ids.sellerA1), await lead(org.ids.sellerA1)];
  await lead(org.ids.sellerA1);
  const [controlNegotiation, controlFollowUp3] = [await lead(org.ids.sellerB1), await lead(org.ids.sellerB1)];

  await createSale(await ctx(org.ids.sellerA1), saleInput(sold, course));
  for (const [id, stage] of [
    [negotiation, "NEGOTIATION"],
    [followUp3, "FOLLOW_UP_3"],
    [controlNegotiation, "NEGOTIATION"],
    [controlFollowUp3, "FOLLOW_UP_3"],
  ] as const) {
    await setLeadStage(handle, id, stage, -1);
  }
  const supA = await ctx(org.ids.supA);
  await trashLead(supA, negotiation);
  await trashLead(supA, followUp3);
  await trashLead(await ctx(supC), onlyTrashed);
});
afterAll(() => handle.close());

describe("indicadores operacionais excluem a Lixeira", () => {
  it("carteira, alertas e fila do supervisor ignoram os leads enviados à Lixeira", async () => {
    const supA = await getLeadIndicators(await ctx(org.ids.supA), NOW);
    expect(stageCounts(supA.portfolio)).toEqual({ CLOSED: 1, NEW: 1 });
    expect(supA.alerts).toEqual({ followUpsOverdue: 0, negotiationsOverdue: 0, awaitingDecision: { unassigned: 0, followUp3Expired: 0 } });
  });

  it("ADMIN: só os vencidos fora da Lixeira (controle da equipe B) aparecem", async () => {
    const admin = await getLeadIndicators(await ctx(org.ids.admin), NOW);
    expect(stageCounts(admin.portfolio)).toEqual({ CLOSED: 1, NEW: 1, NEGOTIATION: 1, FOLLOW_UP_3: 1 });
    expect(admin.alerts).toEqual({ followUpsOverdue: 1, negotiationsOverdue: 1, awaitingDecision: { unassigned: 0, followUp3Expired: 1 } });
  });
});

describe("leads do período e conversão (#28: Lixeira fora do denominador)", () => {
  it("SUPERVISOR/ADMIN: cadastrados no período continuam com a Lixeira identificada; a conversão usa só os de fora da Lixeira", async () => {
    expect(await getLeadIndicators(await ctx(org.ids.supA), NOW)).toMatchObject({
      createdInPeriod: 4,
      trashedInPeriod: 2,
      conversionBase: 2,
      convertedInPeriod: 1,
      conversionRate: 50,
    });
    expect(await getLeadIndicators(await ctx(org.ids.admin), NOW)).toMatchObject({
      createdInPeriod: 7,
      trashedInPeriod: 3,
      conversionBase: 4,
      convertedInPeriod: 1,
      conversionRate: 25,
    });
  });

  it("SELLER: escopo inalterado (não vê nem conta os próprios leads na Lixeira) e mesma conversão da equipe", async () => {
    const seller = await getLeadIndicators(await ctx(org.ids.sellerA1), NOW);
    expect(seller).toMatchObject({ createdInPeriod: 2, trashedInPeriod: 0, conversionBase: 2, convertedInPeriod: 1, conversionRate: 50 });
    // Antes da #28 a equipe (25%) divergia do único vendedor dela (50%); agora coincidem.
    expect((await getLeadIndicators(await ctx(org.ids.supA), NOW)).conversionRate).toBe(seller.conversionRate);
  });

  it("sem leads elegíveis (todos do período na Lixeira): conversão indisponível, cadastrados identificados", async () => {
    expect(await getLeadIndicators(await ctx(supC), NOW)).toMatchObject({
      createdInPeriod: 1,
      trashedInPeriod: 1,
      conversionBase: 0,
      convertedInPeriod: 0,
      conversionRate: null,
    });
    expect(await getLeadIndicators(await ctx(sellerC1), NOW)).toMatchObject({ createdInPeriod: 0, conversionBase: 0, conversionRate: null });
  });

  it("lead com venda válida não vai para a Lixeira: o numerador nunca tem lead na Lixeira", async () => {
    await expect(trashLead(await ctx(org.ids.supA), sold)).rejects.toBeInstanceOf(ValidationError);
  });
});
