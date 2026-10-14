import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { leadCycles, leadEvents, leads, saleEvents, saleItems, sales } from "@/server/db/schema";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, getSale, reverseSale, updateSale } from "@/server/modules/sales/sales.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourseWithCost, saleInput } from "../support/sales";

/**
 * createSale é atômico e seguro para nova tentativa: a falha é injetada
 * DEPOIS de a venda, os itens e o lead já terem sido gravados na transação
 * (dentro de applySaleToLead, após a execução real).
 */
const injected = vi.hoisted(() => ({ failures: [] as unknown[] }));

vi.mock("@/server/modules/leads/leads.service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/leads/leads.service")>();
  return {
    ...original,
    applySaleToLead: async (...args: Parameters<typeof original.applySaleToLead>) => {
      await original.applySaleToLead(...args);
      const failure = injected.failures.shift();
      if (failure) throw failure;
    },
    applySaleReversalToLead: async (...args: Parameters<typeof original.applySaleReversalToLead>) => {
      await original.applySaleReversalToLead(...args);
      const failure = injected.failures.shift();
      if (failure) throw failure;
    },
  };
});

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let seq = 0;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);
});
afterAll(() => handle.close());
beforeEach(() => {
  injected.failures = [];
});

const newLead = async () =>
  (await createLead(await org.ctx(org.ids.sellerA1), { name: "Cliente", phone: `(79) 94${String(++seq).padStart(7, "0")}`, interestCourseId: course })).id;

async function snapshot(leadId: string) {
  return {
    lead: (await handle.db.select().from(leads).where(eq(leads.id, leadId)))[0],
    cycles: await handle.db.select().from(leadCycles).where(eq(leadCycles.leadId, leadId)).orderBy(asc(leadCycles.number)),
    events: await handle.db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId)).orderBy(asc(leadEvents.id)),
    sales: await handle.db.select().from(sales).where(eq(sales.leadId, leadId)),
  };
}

describe("createSale: atomicidade e nova tentativa", () => {
  it("deadlock (40P01) depois de tudo gravado: a transação é refeita e nada se duplica", async () => {
    const leadId = await newLead();
    injected.failures.push(Object.assign(new Error("deadlock simulado"), { code: "40P01" }));
    const input = saleInput(leadId, course, { items: [{ courseId: course, priceCents: 150_000 }, { courseId: course, priceCents: 150_000 }] });

    expect(await createSale(await org.ctx(org.ids.sellerA1), input)).toEqual({ saleId: input.requestId, replayed: false });
    const after = await snapshot(leadId);
    expect(after.sales).toHaveLength(1);
    expect(await handle.db.select().from(saleItems).where(eq(saleItems.saleId, input.requestId as string))).toHaveLength(2);
    expect(await handle.db.select().from(saleEvents).where(eq(saleEvents.saleId, input.requestId as string))).toHaveLength(1);
    expect(after.events.filter((e) => e.type === "SALE_CREATED")).toHaveLength(1);
    expect(after.cycles).toMatchObject([{ endReason: "WON" }]);
    expect(after.lead).toMatchObject({ stage: "CLOSED" });
  });

  it("falha não retentável depois de tudo gravado: rollback integral (venda, itens, eventos, lead e ciclo)", async () => {
    const leadId = await newLead();
    const before = await snapshot(leadId);
    injected.failures.push(new Error("falha simulada"));
    const input = saleInput(leadId, course);

    await expect(createSale(await org.ctx(org.ids.sellerA1), input)).rejects.toThrow("falha simulada");
    expect(await snapshot(leadId)).toEqual(before);
    expect(await handle.db.select().from(saleItems).where(eq(saleItems.saleId, input.requestId as string))).toEqual([]);
    expect(await handle.db.select().from(saleEvents).where(eq(saleEvents.saleId, input.requestId as string))).toEqual([]);

    // A mesma solicitação, repetida depois da falha, é gravada normalmente (uma vez).
    expect(await createSale(await org.ctx(org.ids.sellerA1), input)).toEqual({ saleId: input.requestId, replayed: false });
    expect((await snapshot(leadId)).sales).toHaveLength(1);
  });

  it("estorno: deadlock depois de tudo gravado é refeito sem duplicar; falha comum desfaz tudo", async () => {
    const leadId = await newLead();
    const { saleId } = await createSale(await org.ctx(org.ids.sellerA1), saleInput(leadId, course));
    const sup = await org.ctx(org.ids.supA);
    const version = async () => (await getSale(sup, saleId)).version;
    const before = await snapshot(leadId);

    injected.failures.push(new Error("falha simulada"));
    await expect(reverseSale(sup, saleId, { expectedVersion: await version(), reason: "Teste" })).rejects.toThrow("falha simulada");
    expect(await snapshot(leadId)).toEqual(before);
    expect((await handle.db.select().from(saleEvents).where(eq(saleEvents.saleId, saleId))).map((e) => e.type)).toEqual(["CREATED"]);

    injected.failures.push(Object.assign(new Error("deadlock simulado"), { code: "40P01" }));
    await reverseSale(sup, saleId, { expectedVersion: await version(), reason: "Teste" });
    const after = await snapshot(leadId);
    expect((await handle.db.select().from(saleEvents).where(eq(saleEvents.saleId, saleId))).map((e) => e.type)).toEqual(["CREATED", "REVERSED"]);
    expect(after.events.filter((e) => e.type === "SALE_REVERSED")).toHaveLength(1);
    expect(after.cycles.map((c) => c.kind)).toEqual(["INITIAL", "REOPENED"]);
    expect(after.lead).toMatchObject({ stage: "NEW" });
  });

  it("troca de responsável: deadlock depois de tudo gravado é refeito sem duplicar UPDATED nem SALE_SELLER_CHANGED", async () => {
    const leadId = await newLead();
    const { saleId } = await createSale(await org.ctx(org.ids.sellerA1), saleInput(leadId, course));
    const sup = await org.ctx(org.ids.supA);
    injected.failures.push(Object.assign(new Error("deadlock simulado"), { code: "40001" }));
    await updateSale(sup, saleId, { expectedVersion: (await getSale(sup, saleId)).version, sellerId: org.ids.sellerA2 });

    expect((await handle.db.select().from(saleEvents).where(eq(saleEvents.saleId, saleId))).map((e) => e.type)).toEqual(["CREATED", "UPDATED"]);
    expect((await snapshot(leadId)).events.filter((e) => e.type === "SALE_SELLER_CHANGED")).toHaveLength(1);
    expect((await snapshot(leadId)).lead).toMatchObject({ ownerId: org.ids.sellerA2 });
  });
});
