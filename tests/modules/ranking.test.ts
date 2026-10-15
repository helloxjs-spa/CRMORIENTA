import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { createLead } from "@/server/modules/leads/leads.service";
import { getRanking, type RankingResult } from "@/server/modules/ranking/ranking.service";
import { createSale, getSale, reverseSale } from "@/server/modules/sales/sales.service";
import { changeSellerTeam } from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourseWithCost, saleInput } from "../support/sales";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;

const OCT = { dateFrom: "2026-10-01", dateTo: "2026-10-31" };
const SEP = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
const AUG = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };

let seq = 0;
const nextPhone = () => `(79) 93${String(++seq).padStart(7, "0")}`;

/** Venda registrada pelo ADMIN (que informa a data) para um lead novo do vendedor. */
async function sale(sellerId: string, saleDate: string, priceCents: number): Promise<string> {
  const lead = await createLead(await org.ctx(sellerId), { name: `Cliente ${seq}`, phone: nextPhone(), interestCourseId: course });
  const input = saleInput(lead.id, course, { sellerId, saleDate, items: [{ courseId: course, priceCents }] });
  return (await createSale(await org.ctx(org.ids.admin), input)).saleId;
}

const rank = async (userId: string, input: Record<string, unknown>) => getRanking(await org.ctx(userId), input);
const rows = (result: RankingResult) => (result.mode === "self" ? [] : result.entries.map((e) => [e.name, e.position, e.salesCount, e.revenueCents]));

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);

  // Outubro: A1 2 vendas (R$ 2.000), A2 1 venda (R$ 3.000) + 1 estornada, B1 2 vendas (R$ 1.000).
  await sale(org.ids.sellerA1, "2026-10-02", 100_000);
  await sale(org.ids.sellerA1, "2026-10-05", 100_000);
  await sale(org.ids.sellerA2, "2026-10-03", 300_000);
  const reversed = await sale(org.ids.sellerA2, "2026-10-04", 900_000);
  const admin = await org.ctx(org.ids.admin);
  await reverseSale(admin, reversed, { expectedVersion: (await getSale(admin, reversed)).version, reason: "Desistência" });
  await sale(org.ids.sellerB1, "2026-10-06", 50_000);
  await sale(org.ids.sellerB1, "2026-10-07", 50_000);
  // Setembro: só B1.
  await sale(org.ids.sellerB1, "2026-09-15", 500_000);
});
afterAll(() => handle.close());

describe("ADMIN: ranking completo", () => {
  it("vendedores por quantidade: empate divide a posição; estornada e outro mês não contam", async () => {
    const result = await rank(org.ids.admin, { view: "sellers", criterion: "count", ...OCT });
    expect(result).toMatchObject({ mode: "sellers", scope: "company" });
    expect(rows(result)).toEqual([
      ["Vendedor A1", 1, 2, 200_000],
      ["Vendedor B1", 1, 2, 100_000],
      ["Vendedor A2", 3, 1, 300_000],
    ]);
  });

  it("vendedores por valor faturado", async () => {
    expect(rows(await rank(org.ids.admin, { view: "sellers", criterion: "revenue", ...OCT }))).toEqual([
      ["Vendedor A2", 1, 1, 300_000],
      ["Vendedor A1", 2, 2, 200_000],
      ["Vendedor B1", 3, 2, 100_000],
    ]);
  });

  it("equipes pela equipe da venda; só participa quem vendeu no período", async () => {
    expect(rows(await rank(org.ids.admin, { view: "teams", criterion: "revenue", ...OCT }))).toEqual([
      ["Equipe A", 1, 3, 500_000],
      ["Equipe B", 2, 2, 100_000],
    ]);
    expect(rows(await rank(org.ids.admin, { view: "sellers", criterion: "count", ...SEP }))).toEqual([["Vendedor B1", 1, 1, 500_000]]);
    const teams = await rank(org.ids.admin, { view: "teams", criterion: "count", ...SEP });
    expect(teams.mode === "teams" && teams.entries[0]).toMatchObject({ name: "Equipe B", supervisorName: "Supervisor B" });
  });

  it("intervalo personalizado cruza meses (todos com 1 venda: dividem o 1º lugar)", async () => {
    const range = { dateFrom: "2026-09-15", dateTo: "2026-10-03" };
    expect(rows(await rank(org.ids.admin, { view: "sellers", criterion: "count", ...range }))).toEqual([
      ["Vendedor A1", 1, 1, 100_000],
      ["Vendedor A2", 1, 1, 300_000],
      ["Vendedor B1", 1, 1, 500_000],
    ]);
    expect(rows(await rank(org.ids.admin, { view: "sellers", criterion: "revenue", ...range }))).toEqual([
      ["Vendedor B1", 1, 1, 500_000],
      ["Vendedor A2", 2, 1, 300_000],
      ["Vendedor A1", 3, 1, 100_000],
    ]);
  });
});

describe("SUPERVISOR: própria equipe + ranking das equipes", () => {
  it("vendedores: só as vendas da equipe que lidera", async () => {
    const result = await rank(org.ids.supA, { view: "sellers", criterion: "count", ...OCT });
    expect(result).toMatchObject({ mode: "sellers", scope: "team" });
    expect(rows(result)).toEqual([
      ["Vendedor A1", 1, 2, 200_000],
      ["Vendedor A2", 2, 1, 300_000],
    ]);
    expect(rows(await rank(org.ids.supB, { view: "sellers", criterion: "count", ...OCT }))).toEqual([["Vendedor B1", 1, 2, 100_000]]);
  });

  it("equipes: ranking de todas as equipes", async () => {
    expect(rows(await rank(org.ids.supB, { view: "teams", criterion: "count", ...OCT }))).toEqual([
      ["Equipe A", 1, 3, 500_000],
      ["Equipe B", 2, 2, 100_000],
    ]);
  });

  it("supervisor sem equipe não vê vendedores", async () => {
    const loose = await insertUser(handle, { name: "Supervisor Ranking Sem Equipe", role: "SUPERVISOR" });
    expect(rows(await rank(loose, { view: "sellers", criterion: "count", ...OCT }))).toEqual([]);
  });
});

describe("SELLER: só a própria posição (C42)", () => {
  it("devolve posição, total e os próprios números — nada dos colegas", async () => {
    const result = await rank(org.ids.sellerA2, { view: "sellers", criterion: "revenue", ...OCT });
    expect(result).toEqual({ mode: "self", criterion: "revenue", position: 1, tied: false, total: 3, salesCount: 1, revenueCents: 300_000 });
    const payload = JSON.stringify(await rank(org.ids.sellerA1, { view: "sellers", criterion: "count", ...OCT }));
    for (const leaked of ["Vendedor", "Equipe", org.ids.sellerA2, org.ids.sellerB1, org.ids.teamA, org.ids.teamB, "100000"]) {
      expect(payload).not.toContain(leaked);
    }
  });

  it("empate aparece como empate; sem venda no período = fora do ranking", async () => {
    expect(await rank(org.ids.sellerA1, { view: "sellers", criterion: "count", ...OCT })).toMatchObject({ position: 1, tied: true, total: 3 });
    expect(await rank(org.ids.sellerA1, { view: "sellers", criterion: "count", ...SEP })).toEqual({
      mode: "self",
      criterion: "count",
      position: null,
      tied: false,
      total: 1,
      salesCount: 0,
      revenueCents: 0,
    });
  });

  it("ranking de equipes é recusado no servidor", async () => {
    await expect(rank(org.ids.sellerA1, { view: "teams", criterion: "count", ...OCT })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("validação", () => {
  it("período invertido, datas inválidas e campos não previstos são recusados", async () => {
    for (const input of [
      { view: "sellers", criterion: "count", dateFrom: "2026-10-31", dateTo: "2026-10-01" },
      { view: "sellers", criterion: "count", dateFrom: "2026-02-30", dateTo: "2026-03-01" },
      { view: "sellers", criterion: "lucro", ...OCT },
      { view: "sellers", criterion: "count", ...OCT, teamId: org.ids.teamB },
    ]) {
      await expect(rank(org.ids.admin, input)).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe("atribuição histórica da equipe (C4)", () => {
  it("vendedor que muda de equipe: vendas antigas ficam na equipe da época", async () => {
    const seller = await insertUser(handle, { name: "Vendedor Migrante", role: "SELLER", teamId: org.ids.teamA });
    await sale(seller, "2026-08-05", 70_000);
    await changeSellerTeam(await org.ctx(org.ids.admin), seller, { teamId: org.ids.teamB });
    await sale(seller, "2026-08-20", 30_000);

    expect(rows(await rank(org.ids.admin, { view: "teams", criterion: "revenue", ...AUG }))).toEqual([
      ["Equipe A", 1, 1, 70_000],
      ["Equipe B", 2, 1, 30_000],
    ]);
    // Ranking de vendedores: o vendedor soma tudo; cada supervisor vê só as vendas da própria equipe.
    expect(rows(await rank(org.ids.admin, { view: "sellers", criterion: "count", ...AUG }))).toEqual([["Vendedor Migrante", 1, 2, 100_000]]);
    expect(rows(await rank(org.ids.supA, { view: "sellers", criterion: "count", ...AUG }))).toEqual([["Vendedor Migrante", 1, 1, 70_000]]);
    expect(rows(await rank(org.ids.supB, { view: "sellers", criterion: "count", ...AUG }))).toEqual([["Vendedor Migrante", 1, 1, 30_000]]);
  });
});
