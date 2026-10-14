import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { saleEvents, saleItems, sales } from "@/server/db/schema";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/errors";
import { createLead } from "@/server/modules/leads/leads.service";
import {
  createSale,
  getSale,
  getSaleHistory,
  getSaleWithCost,
  ITEM_NOT_IN_SALE,
  ITEM_REPEATED_IN_REQUEST,
  REQUEST_ID_REUSED,
  updateSale,
} from "@/server/modules/sales/sales.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourseWithCost, saleInput } from "../support/sales";

/**
 * Preço de venda por item (migration 004): total derivado, correção de preço
 * preservando snapshots, permissões e as garantias do banco no COMMIT.
 */

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let course2: string;
let seq = 0;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);
  course2 = await insertCourseWithCost(handle, "Administração", 55_000);
});
afterAll(() => handle.close());

const ctx = (userId: string) => org.ctx(userId);
const newLead = async () =>
  (await createLead(await ctx(org.ids.sellerA1), { name: "Cliente", phone: `(79) 92${String(++seq).padStart(7, "0")}`, interestCourseId: course })).id;
const itemsOf = (saleId: string) => handle.db.select().from(saleItems).where(eq(saleItems.saleId, saleId)).orderBy(asc(saleItems.addedAt), asc(saleItems.id));
const saleRow = async (id: string) => (await handle.db.select().from(sales).where(eq(sales.id, id)))[0];
const version = async (saleId: string) => (await getSale(await ctx(org.ids.admin), saleId)).version;
/** Item pelo preço (itens da mesma transação não têm ordem definida). */
const byPrice = async (saleId: string, priceCents: number) => (await itemsOf(saleId)).find((i) => i.priceCents === priceCents)!;
const lastEvent = async (saleId: string) =>
  (await handle.db.select().from(saleEvents).where(eq(saleEvents.saleId, saleId)).orderBy(asc(saleEvents.id))).at(-1)!;

async function sell(items: { courseId: string; priceCents: number }[]) {
  const leadId = await newLead();
  const input = saleInput(leadId, course, { items });
  const { saleId } = await createSale(await ctx(org.ids.sellerA1), input);
  return { leadId, saleId, input };
}

/** Executa SQL direto numa transação e devolve o erro do COMMIT (ou de antes). */
async function rawTransaction(statements: ReturnType<typeof sql>[]): Promise<unknown> {
  return handle.db
    .transaction(async (tx) => {
      for (const statement of statements) await tx.execute(statement);
    })
    .then(() => null, (error: unknown) => error);
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) parts.push(String((e as Error).message));
  return parts.join(" | ");
}

describe("registro com preços por item", () => {
  it("preços distintos, curso repetido com preço diferente: total = soma; retrato CREATED com os preços", async () => {
    const { saleId } = await sell([
      { courseId: course, priceCents: 120_000 },
      { courseId: course, priceCents: 95_000 },
      { courseId: course2, priceCents: 30_000 },
    ]);
    expect((await saleRow(saleId)).totalCents).toBe(245_000);
    expect((await itemsOf(saleId)).map((i) => [i.courseId, i.priceCents]).sort()).toEqual(
      [
        [course, 95_000],
        [course, 120_000],
        [course2, 30_000],
      ].sort(),
    );
    const created = (await lastEvent(saleId)).metadata as { sale: { totalCents: number }; items: { priceCents: number }[] };
    expect(created.sale.totalCents).toBe(245_000);
    expect(created.items.map((i) => i.priceCents).sort((x, y) => x - y)).toEqual([30_000, 95_000, 120_000]);
  });

  it("idempotência compara os pares (curso, preço), em qualquer ordem, inclusive repetidos", async () => {
    const items = [
      { courseId: course, priceCents: 100_000 },
      { courseId: course, priceCents: 200_000 },
    ];
    const { input } = await sell(items);
    const seller = await ctx(org.ids.sellerA1);
    expect(await createSale(seller, { ...input, items: [...items].reverse() })).toEqual({ saleId: input.requestId, replayed: true });
    const swapped = { ...input, items: [{ courseId: course, priceCents: 100_000 }, { courseId: course, priceCents: 100_000 }] };
    const error = await createSale(seller, swapped).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toBe(REQUEST_ID_REUSED);
  });
});

describe("edição de itens e preços", () => {
  it("SUPERVISOR remove, corrige e inclui na mesma edição: total recalculado e histórico completo", async () => {
    const { saleId } = await sell([
      { courseId: course, priceCents: 100_000 },
      { courseId: course2, priceCents: 50_000 },
    ]);
    const [a, b] = [await byPrice(saleId, 100_000), await byPrice(saleId, 50_000)];
    await updateSale(await ctx(org.ids.supA), saleId, {
      expectedVersion: await version(saleId),
      removeItemIds: [a.id],
      repriceItems: [{ itemId: b.id, priceCents: 60_000 }],
      addItems: [{ courseId: course, priceCents: 10_000 }],
    });
    expect((await saleRow(saleId)).totalCents).toBe(70_000);
    const metadata = (await lastEvent(saleId)).metadata as {
      changes: Record<string, unknown>;
      itemsAdded: { priceCents: number }[];
      itemsRemoved: { id: string; priceCents: number }[];
      itemsRepriced: unknown[];
    };
    expect(metadata.changes).toEqual({ totalCents: { from: 150_000, to: 70_000 } });
    expect(metadata.itemsRemoved.map((i) => [i.id, i.priceCents])).toEqual([[a.id, 100_000]]);
    expect(metadata.itemsRepriced).toEqual([{ id: b.id, courseId: course2, from: 50_000, to: 60_000 }]);
    expect(metadata.itemsAdded.map((i) => i.priceCents)).toEqual([10_000]);
  });

  it("ADMIN corrige preço; custo e comissão do item ficam exatamente iguais", async () => {
    const { saleId } = await sell([{ courseId: course2, priceCents: 80_000 }]);
    const [before] = await itemsOf(saleId);
    await updateSale(await ctx(org.ids.admin), saleId, { expectedVersion: await version(saleId), repriceItems: [{ itemId: before.id, priceCents: 81_500 }] });
    const [after] = await itemsOf(saleId);
    expect({ ...after, priceCents: before.priceCents, priceChangedTxid: null, priceTxBase: null }).toEqual({
      ...before,
      priceChangedTxid: null,
      priceTxBase: null,
    });
    expect(after.priceCents).toBe(81_500);
    expect((await saleRow(saleId)).totalCents).toBe(81_500);
  });

  it("SELLER: inclui com preço, mas não remove nem corrige (e não contorna com remover + incluir)", async () => {
    const { saleId } = await sell([{ courseId: course, priceCents: 100_000 }]);
    const [item] = await itemsOf(saleId);
    const seller = await ctx(org.ids.sellerA1);
    const v = await version(saleId);
    await expect(updateSale(seller, saleId, { expectedVersion: v, removeItemIds: [item.id] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateSale(seller, saleId, { expectedVersion: v, repriceItems: [{ itemId: item.id, priceCents: 1 }] })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      updateSale(seller, saleId, { expectedVersion: v, removeItemIds: [item.id], addItems: [{ courseId: course, priceCents: 1 }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await version(saleId)).toBe(v);
    await updateSale(seller, saleId, { expectedVersion: v, addItems: [{ courseId: course2, priceCents: 5_000 }] });
    expect((await saleRow(saleId)).totalCents).toBe(105_000);
  });

  it("validações: preço > 0, item atual da venda, um único ajuste por item, sem total no payload", async () => {
    const { saleId } = await sell([
      { courseId: course, priceCents: 100_000 },
      { courseId: course2, priceCents: 50_000 },
    ]);
    const [a, b] = [await byPrice(saleId, 100_000), await byPrice(saleId, 50_000)];
    const other = await sell([{ courseId: course, priceCents: 1_000 }]);
    const [foreign] = await itemsOf(other.saleId);
    const sup = await ctx(org.ids.supA);
    const v = await version(saleId);
    await expect(updateSale(sup, saleId, { expectedVersion: v, repriceItems: [{ itemId: a.id, priceCents: 0 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateSale(sup, saleId, { expectedVersion: v, addItems: [{ courseId: course, priceCents: -5 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateSale(sup, saleId, { expectedVersion: v, repriceItems: [{ itemId: foreign.id, priceCents: 9 }] })).rejects.toThrow(ITEM_NOT_IN_SALE);
    await expect(
      updateSale(sup, saleId, { expectedVersion: v, removeItemIds: [a.id], repriceItems: [{ itemId: a.id, priceCents: 9 }] }),
    ).rejects.toThrow(ITEM_REPEATED_IN_REQUEST);
    await expect(updateSale(sup, saleId, { expectedVersion: v, totalCents: 1 })).rejects.toBeInstanceOf(ValidationError);

    // Item removido não pode mais ser corrigido.
    await updateSale(sup, saleId, { expectedVersion: v, removeItemIds: [b.id] });
    await expect(updateSale(sup, saleId, { expectedVersion: await version(saleId), repriceItems: [{ itemId: b.id, priceCents: 9 }] })).rejects.toThrow(
      ITEM_NOT_IN_SALE,
    );
  });

  it("consultas: preço para todos no escopo; custo e lucro só para o ADMIN; correção de preço no histórico sem custos", async () => {
    const { saleId } = await sell([{ courseId: course, priceCents: 100_000 }]);
    const [item] = await itemsOf(saleId);
    await updateSale(await ctx(org.ids.supA), saleId, { expectedVersion: await version(saleId), repriceItems: [{ itemId: item.id, priceCents: 90_000 }] });

    for (const userId of [org.ids.sellerA1, org.ids.supA]) {
      const viewer = await ctx(userId);
      const sale = await getSale(viewer, saleId);
      expect(sale.items.map((i) => i.priceCents)).toEqual([90_000]);
      const history = await getSaleHistory(viewer, saleId);
      expect(history.at(-1)!.metadata).toMatchObject({ itemsRepriced: [{ id: item.id, from: 100_000, to: 90_000 }] });
      const payload = JSON.stringify([sale, history]);
      expect(payload).not.toMatch(/cost|profit/i);
      expect(payload).not.toContain("40000");
      await expect(getSaleWithCost(viewer, saleId)).rejects.toBeInstanceOf(ForbiddenError);
    }
    const withCost = await getSaleWithCost(await ctx(org.ids.admin), saleId);
    expect(withCost.items.map((i) => [i.priceCents, i.costSnapshotCents, i.profitCents])).toEqual([[90_000, 40_000, 50_000]]);
    expect([withCost.costTotalCents, withCost.profitTotalCents]).toEqual([40_000, 50_000]);
  });
});

describe("garantias do banco (SQL direto, migration 004)", () => {
  it("total incompatível com os itens é recusado no COMMIT", async () => {
    const { saleId } = await sell([{ courseId: course, priceCents: 100_000 }]);
    const error = await rawTransaction([
      sql`UPDATE sales SET total_cents = total_cents + 1 WHERE id = ${saleId}`,
      sql`INSERT INTO sale_events (sale_id, type, actor_id) VALUES (${saleId}, 'UPDATED', ${org.ids.admin})`,
    ]);
    expect(errorText(error)).toContain("diferente da soma dos preços dos itens atuais");
    expect((await saleRow(saleId)).totalCents).toBe(100_000);
  });

  it("correção de preço sem o evento UPDATED (ou sem ajustar o total) é recusada", async () => {
    const { saleId } = await sell([{ courseId: course, priceCents: 100_000 }]);
    const [item] = await itemsOf(saleId);
    const noEvent = await rawTransaction([
      sql`UPDATE sale_items SET price_cents = 90000 WHERE id = ${item.id}`,
      sql`UPDATE sales SET total_cents = 90000 WHERE id = ${saleId}`,
    ]);
    expect(errorText(noEvent)).toContain("sem o evento UPDATED");
    const noTotal = await rawTransaction([
      sql`UPDATE sale_items SET price_cents = 90000 WHERE id = ${item.id}`,
      sql`INSERT INTO sale_events (sale_id, type, actor_id) VALUES (${saleId}, 'UPDATED', ${org.ids.admin})`,
    ]);
    expect(errorText(noTotal)).toContain("diferente da soma");
    expect((await itemsOf(saleId))[0].priceCents).toBe(100_000);
  });

  it("correção de preço por SQL direto, com total e evento: aceita, com antes/depois calculado pelo banco", async () => {
    const { saleId } = await sell([{ courseId: course, priceCents: 100_000 }]);
    const [item] = await itemsOf(saleId);
    expect(
      await rawTransaction([
        sql`UPDATE sale_items SET price_cents = 75000 WHERE id = ${item.id}`,
        sql`UPDATE sales SET total_cents = 75000 WHERE id = ${saleId}`,
        sql`INSERT INTO sale_events (sale_id, type, actor_id) VALUES (${saleId}, 'UPDATED', ${org.ids.admin})`,
      ]),
    ).toBeNull();
    expect((await lastEvent(saleId)).metadata).toMatchObject({ itemsRepriced: [{ id: item.id, from: 100_000, to: 75_000 }] });
  });

  it("snapshots, preço ≤ 0 e remoção + correção do mesmo item são recusados pelo banco", async () => {
    const { saleId } = await sell([
      { courseId: course, priceCents: 100_000 },
      { courseId: course2, priceCents: 50_000 },
    ]);
    const a = await byPrice(saleId, 100_000);
    for (const statement of [
      sql`UPDATE sale_items SET cost_snapshot_cents = 1 WHERE id = ${a.id}`,
      sql`UPDATE sale_items SET commission_snapshot_cents = 1, price_cents = 1 WHERE id = ${a.id}`,
      sql`UPDATE sale_items SET price_cents = 0 WHERE id = ${a.id}`,
      sql`UPDATE sale_items SET price_cents = 1, removed_at = now(), removed_by = ${org.ids.admin} WHERE id = ${a.id}`,
      sql`UPDATE sale_items SET price_tx_base = 1 WHERE id = ${a.id}`,
    ]) {
      expect(await rawTransaction([statement])).not.toBeNull();
    }
    const repriceThenRemove = await rawTransaction([
      sql`UPDATE sale_items SET price_cents = 90000 WHERE id = ${a.id}`,
      sql`UPDATE sale_items SET removed_at = now(), removed_by = ${org.ids.admin} WHERE id = ${a.id}`,
    ]);
    expect(errorText(repriceThenRemove)).toContain("preço corrigido nesta transação não pode ser removido");
    expect((await itemsOf(saleId)).map((i) => [i.priceCents, i.removedAt]).sort()).toEqual([
      [100_000, null],
      [50_000, null],
    ].sort());
  });
});
