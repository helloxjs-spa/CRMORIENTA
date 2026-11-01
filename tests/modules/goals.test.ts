import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents, salesGoals } from "@/server/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { getMonthlyResult, setSalesGoal } from "@/server/modules/goals/goals.service";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, getSale, reverseSale } from "@/server/modules/sales/sales.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourseWithCost } from "../support/sales";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let seq = 0;
const ctx = (userId: string) => org.ctx(userId);

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 50_000);
});
afterAll(() => handle.close());

/** Venda Pix registrada pelo ADMIN (que informa a data) para um lead novo do vendedor. */
async function sale(sellerId: string, saleDate: string, priceCents: number): Promise<string> {
  const lead = await createLead(await ctx(sellerId), { name: `Aluno ${++seq}`, phone: `(79) 96${String(seq).padStart(7, "0")}`, interestCourseId: course });
  const input = { requestId: crypto.randomUUID(), leadId: lead.id, sellerId, saleDate, paymentMethod: "PIX", items: [{ courseId: course, priceCents }] };
  return (await createSale(await ctx(org.ids.admin), input)).saleId;
}

describe("Resultado do mês", () => {
  it("realizado do time e por vendedor (só vendas válidas, pela data da venda) e mês anterior", async () => {
    await sale(org.ids.sellerA1, "2026-08-20", 100_000);
    await sale(org.ids.sellerA1, "2026-09-01", 300_000);
    await sale(org.ids.sellerA1, "2026-09-30", 200_000);
    await sale(org.ids.sellerB1, "2026-09-15", 150_000);
    const reversed = await sale(org.ids.sellerB1, "2026-09-16", 999_000);
    const { version } = await getSale(await ctx(org.ids.admin), reversed);
    await reverseSale(await ctx(org.ids.admin), reversed, { expectedVersion: version, reason: "Teste de estorno." });
    await sale(org.ids.sellerA2, "2026-10-01", 50_000);

    // Vendedor também vê o time e os colegas (todos veem tudo).
    const result = await getMonthlyResult(await ctx(org.ids.sellerB1), "2026-09");
    expect(result.realizedCents).toBe(650_000);
    expect(result.previousRealizedCents).toBe(100_000);
    const bySeller = Object.fromEntries(result.sellers.map((s) => [s.sellerId, s.realizedCents]));
    expect(bySeller).toMatchObject({ [org.ids.sellerA1]: 500_000, [org.ids.sellerB1]: 150_000, [org.ids.sellerA2]: 0 });
    expect(result.sellers.map((s) => s.sellerId)).toEqual([org.ids.sellerA1, org.ids.sellerB1, org.ids.sellerA2]);
    expect(result.sellers.every((s) => !s.canEditGoal)).toBe(true);
    // Só faturamento: nada de custo ou lucro no retorno.
    expect(JSON.stringify(result)).not.toMatch(/cost|profit/i);
  });

  it("metas: geral pelo admin; vendedor pelo admin ou pelo supervisor da equipe; auditoria com antes e depois", async () => {
    await setSalesGoal(await ctx(org.ids.admin), { month: "2026-09", sellerId: null, amountCents: 10_000_000 });
    await setSalesGoal(await ctx(org.ids.supA), { month: "2026-09", sellerId: org.ids.sellerA1, amountCents: 1_000_000 });
    await setSalesGoal(await ctx(org.ids.admin), { month: "2026-09", sellerId: org.ids.sellerB1, amountCents: 500_000 });

    const asSupA = await getMonthlyResult(await ctx(org.ids.supA), "2026-09");
    expect(asSupA).toMatchObject({ generalGoalCents: 10_000_000, canEditGeneralGoal: false });
    const row = (id: string) => asSupA.sellers.find((s) => s.sellerId === id)!;
    expect(row(org.ids.sellerA1)).toMatchObject({ goalCents: 1_000_000, canEditGoal: true });
    expect(row(org.ids.sellerB1)).toMatchObject({ goalCents: 500_000, canEditGoal: false });
    expect(row(org.ids.sellerA2)).toMatchObject({ goalCents: null, canEditGoal: true });
    expect((await getMonthlyResult(await ctx(org.ids.admin), "2026-09")).canEditGeneralGoal).toBe(true);

    await setSalesGoal(await ctx(org.ids.supA), { month: "2026-09", sellerId: org.ids.sellerA1, amountCents: 1_200_000 });
    const [goal] = await handle.db.select().from(salesGoals).where(eq(salesGoals.sellerId, org.ids.sellerA1));
    const audit = await handle.db.select().from(auditEvents).where(eq(auditEvents.entityId, goal.id));
    expect(audit.map((e) => e.metadata)).toEqual([
      { month: "2026-09", sellerId: org.ids.sellerA1, fromCents: null, toCents: 1_000_000 },
      { month: "2026-09", sellerId: org.ids.sellerA1, fromCents: 1_000_000, toCents: 1_200_000 },
    ]);
    expect(audit[1]).toMatchObject({ action: "goal.set", entityType: "sales_goal", actorId: org.ids.supA, teamId: org.ids.teamA });
    expect(goal).toMatchObject({ amountCents: 1_200_000, createdBy: org.ids.supA, updatedBy: org.ids.supA });

    // Mesmo valor: nada muda, nenhum evento novo.
    await setSalesGoal(await ctx(org.ids.supA), { month: "2026-09", sellerId: org.ids.sellerA1, amountCents: 1_200_000 });
    expect(await handle.db.select().from(auditEvents).where(eq(auditEvents.entityId, goal.id))).toHaveLength(2);
  });

  it("retirar a meta grava NULL e volta a 'sem meta'", async () => {
    await setSalesGoal(await ctx(org.ids.admin), { month: "2026-09", sellerId: org.ids.sellerB1, amountCents: null });
    const result = await getMonthlyResult(await ctx(org.ids.admin), "2026-09");
    expect(result.sellers.find((s) => s.sellerId === org.ids.sellerB1)!.goalCents).toBeNull();
    const [row] = await handle.db.select().from(salesGoals).where(eq(salesGoals.sellerId, org.ids.sellerB1));
    expect(row.amountCents).toBeNull();
  });

  it("permissões, escopo do supervisor e validação", async () => {
    const goal = (sellerId: string | null) => ({ month: "2026-11", sellerId, amountCents: 100_000 });
    await expect(setSalesGoal(await ctx(org.ids.sellerA1), goal(org.ids.sellerA1))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setSalesGoal(await ctx(org.ids.supA), goal(null))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setSalesGoal(await ctx(org.ids.supA), goal(org.ids.sellerB1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(setSalesGoal(await ctx(org.ids.admin), goal(org.ids.supA))).rejects.toBeInstanceOf(NotFoundError);
    for (const input of [
      { month: "2026-13", sellerId: null, amountCents: 1 },
      { month: "2026-11", sellerId: null, amountCents: 0 },
      { month: "2026-11", sellerId: null, amountCents: Number.NaN },
      { month: "2026-11", sellerId: null, amountCents: 10.5 },
      { month: "2026-11", sellerId: null, amountCents: 1, extra: true },
    ]) {
      await expect(setSalesGoal(await ctx(org.ids.admin), input)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await getMonthlyResult(await ctx(org.ids.admin), "2026-11")).toMatchObject({ generalGoalCents: null });
  });

  it("vendedor inativo: fora da lista se não vendeu nem tinha meta no mês; não recebe meta nova", async () => {
    const gone = await insertUser(handle, { name: "Zé Saiu", role: "SELLER", teamId: null, active: false });
    const result = await getMonthlyResult(await ctx(org.ids.admin), "2026-12");
    expect(result.sellers.some((s) => s.sellerId === gone)).toBe(false);
    await expect(setSalesGoal(await ctx(org.ids.admin), { month: "2026-12", sellerId: gone, amountCents: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });
});
