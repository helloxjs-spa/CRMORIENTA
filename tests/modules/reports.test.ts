import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { DatabaseHandle } from "@/server/db/connect";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { registerCertificate } from "@/server/modules/certificates/certificates.service";
import { getSalesIndicators } from "@/server/modules/dashboard/dashboard.service";
import { createLead } from "@/server/modules/leads/leads.service";
import { buildReport, type Report } from "@/server/modules/reports/reports.service";
import { createSale, getSale, reverseSale } from "@/server/modules/sales/sales.service";
import { changeSellerTeam } from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourseWithCost } from "../support/sales";

/**
 * Cenário (curso com custo de bolsa R$ 400, comissão R$ 100 por item), vendas em julho:
 *   A1: venda Pix R$ 1.000 (2 cursos) e venda estornada R$ 900;
 *   Migrante: na equipe A vende R$ 2.000 no cartão 2x; depois vai para a equipe B;
 *   B1: venda Pix R$ 500.
 */
let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let migrant: string;
let migrantSale: string;

const JUL = { dateFrom: "2026-07-01", dateTo: "2026-07-31" };
let seq = 0;
const nextPhone = () => `(79) 98${String(++seq).padStart(7, "0")}`;
const ctx = (userId: string) => org.ctx(userId);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(new Date());

async function sale(sellerId: string, prices: number[], opts: { date?: string; card?: number; name?: string } = {}): Promise<string> {
  const lead = await createLead(await ctx(sellerId), { name: opts.name ?? `Cliente Relatório ${seq + 1}`, phone: nextPhone(), interestCourseId: course });
  const input = {
    requestId: crypto.randomUUID(),
    leadId: lead.id,
    sellerId,
    saleDate: opts.date ?? "2026-07-10",
    paymentMethod: opts.card ? "CARD" : "PIX",
    ...(opts.card ? { installmentCount: opts.card } : {}),
    items: prices.map((priceCents) => ({ courseId: course, priceCents })),
  };
  return (await createSale(await ctx(org.ids.admin), input)).saleId;
}
const report = async (userId: string, type: string, filters: Record<string, string> = {}) => buildReport(await ctx(userId), type, filters);
const column = (r: Report, name: string) => r.rows.map((row) => row[r.header.indexOf(name)]);

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);
  const admin = await ctx(org.ids.admin);

  await sale(org.ids.sellerA1, [60_000, 40_000], { name: "Aluno A1" });
  const reversed = await sale(org.ids.sellerA1, [90_000]);
  await reverseSale(admin, reversed, { expectedVersion: (await getSale(admin, reversed)).version, reason: "Desistência" });
  migrant = await insertUser(handle, { name: "Vendedor Migrante", role: "SELLER", teamId: org.ids.teamA });
  migrantSale = await sale(migrant, [200_000], { card: 2, name: "Aluno Migrante" });
  await changeSellerTeam(admin, migrant, { teamId: org.ids.teamB });
  await sale(org.ids.sellerB1, [50_000], { name: "Aluno B1" });
  const [item] = (await getSale(admin, migrantSale)).items;
  await registerCertificate(await ctx(migrant), { saleItemId: item.id, completedOn: "2026-09-01", deliveredOn: "2026-09-05", certifier: "Cert X" });
});
afterAll(() => handle.close());

describe("acesso", () => {
  it("SELLER não exporta (dúvida #3: negado); tipo e filtros inválidos são recusados", async () => {
    await expect(report(org.ids.sellerA1, "sales")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(report(org.ids.admin, "costs")).rejects.toBeInstanceOf(ValidationError);
    await expect(report(org.ids.admin, "commissions", { status: "REVERSED" })).rejects.toBeInstanceOf(ValidationError);
    await expect(report(org.ids.admin, "sales", { sellerId: org.ids.sellerA1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(report(org.ids.admin, "sales", { dateFrom: "2026-08-01", dateTo: "2026-07-01" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("vendas e itens", () => {
  it("custo das bolsas e lucro só para o ADMIN (lucro = venda − custo)", async () => {
    const admin = await report(org.ids.admin, "sales", JUL);
    expect(admin.header).toEqual(expect.arrayContaining(["Custo das bolsas", "Lucro"]));
    const a1 = admin.rows.find((row) => row[1] === "Aluno A1")!;
    expect(a1.slice(-2)).toEqual([{ cents: 80_000 }, { cents: 20_000 }]);

    const supervisor = await report(org.ids.supA, "sales", JUL);
    expect(supervisor.header.join()).not.toMatch(/Custo|Lucro/);
    expect(JSON.stringify(supervisor.rows)).not.toContain("80000");
    const items = await report(org.ids.supA, "items", JUL);
    expect(items.header.join()).not.toMatch(/Custo|Lucro/);
    expect((await report(org.ids.admin, "items", JUL)).header).toEqual(expect.arrayContaining(["Custo da bolsa", "Lucro do item"]));
  });

  it("C50: o supervisor vê as vendas dos vendedores que estão HOJE na equipe, inclusive as anteriores à transferência", async () => {
    expect(column(await report(org.ids.supA, "sales", JUL), "Lead").sort()).toEqual(["Aluno A1", expect.stringMatching(/^Cliente/)]);
    expect(column(await report(org.ids.supB, "sales", JUL), "Lead").sort()).toEqual(["Aluno B1", "Aluno Migrante"]);
    // A coluna histórica continua mostrando a equipe registrada na venda.
    const migrantRow = (await report(org.ids.supB, "sales", JUL)).rows.find((row) => row[1] === "Aluno Migrante")!;
    expect(migrantRow[5]).toBe("Equipe A");
  });

  it("situação filtra válidas ou estornadas; itens: uma linha por curso atual", async () => {
    expect(column(await report(org.ids.admin, "sales", { ...JUL, status: "REVERSED" }), "Situação")).toEqual(["Estornada"]);
    const items = await report(org.ids.admin, "items", { ...JUL, status: "ACTIVE" });
    expect(items.rows).toHaveLength(4);
    expect(column(items, "Comissão")).toEqual(Array(4).fill({ cents: BUSINESS_RULES.commissionPerItemCents }));
  });
});

describe("comissões e desempenho", () => {
  it("comissão por vendedor = a do Dashboard (vendas válidas, data da venda); estornada fora", async () => {
    const commissions = await report(org.ids.admin, "commissions", JUL);
    expect(commissions.rows).toEqual([
      ["Vendedor A1", 1, 2, { cents: 20_000 }],
      ["Vendedor B1", 1, 1, { cents: 10_000 }],
      ["Vendedor Migrante", 1, 1, { cents: 10_000 }],
    ]);
    const total = commissions.rows.reduce((sum, row) => sum + (row[3] as { cents: number }).cents, 0);
    expect(total).toBe((await getSalesIndicators(await ctx(org.ids.admin), JUL)).commissionCents);
    expect((await report(org.ids.supB, "commissions", JUL)).rows.map((row) => row[0])).toEqual(["Vendedor B1", "Vendedor Migrante"]);
  });

  it("desempenho reutiliza o Ranking: equipes pela equipe atual (C50); supervisor vê os vendedores da equipe", async () => {
    const teams = await report(org.ids.admin, "performance", { ...JUL, view: "teams", criterion: "revenue" });
    expect(teams.rows.map((row) => [row[2], row[4], row[5]])).toEqual([
      ["Equipe B", 2, { cents: 250_000 }],
      ["Equipe A", 1, { cents: 100_000 }],
    ]);
    const sellers = await report(org.ids.supB, "performance", { ...JUL, view: "sellers", criterion: "count" });
    expect(sellers.rows.map((row) => row[2]).sort()).toEqual(["Vendedor B1", "Vendedor Migrante"]);
    await expect(report(org.ids.admin, "performance", { view: "teams", criterion: "revenue" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("leads, parcelas e certificados", () => {
  it("leads pela data de cadastro (fuso do negócio) e situação", async () => {
    const all = await report(org.ids.admin, "leads", { dateFrom: today(), dateTo: today() });
    expect(all.rows.length).toBe(4);
    expect((await report(org.ids.admin, "leads", { dateFrom: "2020-01-01", dateTo: "2020-12-31" })).rows).toEqual([]);
    expect((await report(org.ids.admin, "leads", { status: "TRASHED" })).rows).toEqual([]);
    expect(column(await report(org.ids.supB, "leads"), "Nome").sort()).toEqual(["Aluno B1"]);
  });

  it("parcelas e certificados com o escopo do módulo", async () => {
    const installments = await report(org.ids.supB, "installments");
    expect(installments.rows.map((row) => [row[1], row[2], row[3], row[4]])).toEqual([
      ["Aluno Migrante", "1/2", { cents: 100_000 }, "Vencida"],
      ["Aluno Migrante", "2/2", { cents: 100_000 }, "Vencida"],
    ]);
    expect((await report(org.ids.supA, "installments")).rows).toEqual([]);

    const certificates = await report(org.ids.supB, "certificates", { dateField: "completed", dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    expect(certificates.rows.map((row) => [row[0], row[3], row[7]])).toEqual([["Aluno Migrante", "Vendedor Migrante", "Cert X"]]);
    expect((await report(org.ids.supA, "certificates")).rows).toEqual([]);
  });
});
