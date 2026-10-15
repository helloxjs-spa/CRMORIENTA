import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { saleEvents } from "@/server/db/schema";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, getSale, listSales, reactivateSale, reverseSale } from "@/server/modules/sales/sales.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourseWithCost, saleInput } from "../support/sales";

/**
 * Área de Estornos (§15): a listagem traz o último estorno (data/hora, autor,
 * motivo) lido de sale_events, com o mesmo escopo de listSales.
 */
let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let reversedTwice: string;
let reactivated: string;
let stillActive: string;
let reversedOfB1: string;

let seq = 0;
const nextPhone = () => `(79) 92${String(++seq).padStart(7, "0")}`;
const ctx = (userId: string) => org.ctx(userId);

async function newSale(sellerId: string): Promise<string> {
  const lead = await createLead(await ctx(sellerId), { name: `Cliente Estorno ${seq}`, phone: nextPhone(), interestCourseId: course });
  return (await createSale(await ctx(sellerId), saleInput(lead.id, course))).saleId;
}
const version = async (saleId: string) => (await getSale(await ctx(org.ids.admin), saleId)).version;
const reverse = async (userId: string, saleId: string, reason: string) =>
  reverseSale(await ctx(userId), saleId, { expectedVersion: await version(saleId), reason });
const reactivate = async (userId: string, saleId: string, reason: string) =>
  reactivateSale(await ctx(userId), saleId, { expectedVersion: await version(saleId), reason });
const reversedList = async (userId: string) => listSales(await ctx(userId), { status: "REVERSED" });

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);

  // A1: estornada, reativada e estornada de novo (dois REVERSED no histórico).
  reversedTwice = await newSale(org.ids.sellerA1);
  await reverse(org.ids.supA, reversedTwice, "Cliente desistiu");
  await reactivate(org.ids.admin, reversedTwice, "Cliente voltou atrás");
  await reverse(org.ids.admin, reversedTwice, "Pagamento recusado");
  // A2: estornada e reativada (hoje válida).
  reactivated = await newSale(org.ids.sellerA2);
  await reverse(org.ids.supA, reactivated, "Engano");
  await reactivate(org.ids.supA, reactivated, "Estorno indevido");
  // A1: nunca estornada.
  stillActive = await newSale(org.ids.sellerA1);
  // B1: estornada pelo supervisor B.
  reversedOfB1 = await newSale(org.ids.sellerB1);
  await reverse(org.ids.supB, reversedOfB1, "Duplicada");
});
afterAll(() => handle.close());

describe("dados do último estorno na listagem", () => {
  it("mostra data/hora, autor e motivo do ÚLTIMO estorno, sem apagar o anterior do histórico", async () => {
    const { items } = await reversedList(org.ids.admin);
    const entry = items.find((s) => s.id === reversedTwice)!;
    expect(entry.lastReversal).toMatchObject({ actorName: "Admin", reason: "Pagamento recusado" });
    expect(entry.lastReversal!.occurredAt).toBeInstanceOf(Date);

    const events = await handle.db
      .select({ type: saleEvents.type, reason: saleEvents.reason })
      .from(saleEvents)
      .where(and(eq(saleEvents.saleId, reversedTwice)))
      .orderBy(asc(saleEvents.id));
    expect(events.map((e) => [e.type, e.reason])).toEqual([
      ["CREATED", null],
      ["REVERSED", "Cliente desistiu"],
      ["REACTIVATED", "Cliente voltou atrás"],
      ["REVERSED", "Pagamento recusado"],
    ]);
  });

  it("venda reativada não aparece em Estornos; venda válida não traz dados de estorno", async () => {
    const { items } = await reversedList(org.ids.admin);
    expect(items.map((s) => s.id).sort()).toEqual([reversedTwice, reversedOfB1].sort());
    const all = (await listSales(await ctx(org.ids.admin), {})).items;
    expect(all.find((s) => s.id === reactivated)).toMatchObject({ status: "ACTIVE", lastReversal: null });
    expect(all.find((s) => s.id === stillActive)).toMatchObject({ status: "ACTIVE", lastReversal: null });
    expect(all.find((s) => s.id === reversedOfB1)).toMatchObject({ lastReversal: { actorName: "Supervisor B", reason: "Duplicada" } });
  });
});

describe("limites de acesso (mesmo escopo de listSales)", () => {
  it("SELLER vê só os próprios estornos (como no histórico da venda)", async () => {
    const a1 = await reversedList(org.ids.sellerA1);
    expect(a1.items.map((s) => s.id)).toEqual([reversedTwice]);
    expect(a1.items[0].lastReversal).toMatchObject({ actorName: "Admin", reason: "Pagamento recusado" });
    expect((await reversedList(org.ids.sellerA2)).total).toBe(0);
    expect((await reversedList(org.ids.sellerB1)).items.map((s) => s.id)).toEqual([reversedOfB1]);
  });

  it("SUPERVISOR vê só os estornos dos vendedores da equipe; ADMIN vê todos", async () => {
    expect((await reversedList(org.ids.supA)).items.map((s) => s.id)).toEqual([reversedTwice]);
    expect((await reversedList(org.ids.supB)).items.map((s) => s.id)).toEqual([reversedOfB1]);
    expect((await reversedList(org.ids.admin)).total).toBe(2);
  });

  it("nenhum custo de bolsa sai na listagem de estornos", async () => {
    const payload = JSON.stringify(await reversedList(org.ids.supA));
    expect(payload).not.toMatch(/cost/i);
  });
});
