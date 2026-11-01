import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { salesGoals } from "@/server/db/schema";
import { createTestDatabase, seedOrganization } from "../support/db";

/** Regras do 008 garantidas pelo BANCO (independentes do serviço). */
let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
});
afterAll(() => handle.close());

const goal = (values: Partial<typeof salesGoals.$inferInsert>) =>
  handle.db
    .insert(salesGoals)
    .values({ month: "2026-09-01", amountCents: 100_000_00, createdBy: org.ids.admin, updatedBy: org.ids.admin, ...values })
    .returning();

describe("sales_goals (008)", () => {
  it("uma meta geral por mês e uma por vendedor por mês", async () => {
    await goal({});
    await expect(goal({})).rejects.toThrow();
    await goal({ sellerId: org.ids.sellerA1 });
    await expect(goal({ sellerId: org.ids.sellerA1 })).rejects.toThrow();
    await goal({ sellerId: org.ids.sellerA2 });
    await goal({ month: "2026-10-01" });
  });

  it("mês no dia 1, valor positivo (NULL = retirada) e meta individual só para vendedor", async () => {
    await expect(goal({ month: "2026-08-15" })).rejects.toThrow();
    await expect(goal({ month: "2026-07-01", amountCents: 0 })).rejects.toThrow();
    await expect(goal({ month: "2026-07-01", sellerId: org.ids.supA })).rejects.toThrow();
    await expect(goal({ month: "2026-07-01", amountCents: null })).resolves.toHaveLength(1);
  });

  it("sem exclusão física; mês e vendedor imutáveis; valor pode mudar", async () => {
    const [row] = await goal({ month: "2026-06-01", sellerId: org.ids.sellerB1 });
    await handle.db.update(salesGoals).set({ amountCents: 5_000_00, updatedBy: org.ids.supB }).where(eq(salesGoals.id, row.id));
    await handle.db.update(salesGoals).set({ amountCents: null }).where(eq(salesGoals.id, row.id));
    await expect(handle.db.update(salesGoals).set({ month: "2026-05-01" }).where(eq(salesGoals.id, row.id))).rejects.toThrow();
    await expect(handle.db.update(salesGoals).set({ sellerId: org.ids.sellerA1 }).where(eq(salesGoals.id, row.id))).rejects.toThrow();
    await expect(handle.db.delete(salesGoals).where(eq(salesGoals.id, row.id))).rejects.toThrow();
    await expect(handle.db.execute(sql`TRUNCATE public.sales_goals`)).rejects.toThrow();
  });
});
