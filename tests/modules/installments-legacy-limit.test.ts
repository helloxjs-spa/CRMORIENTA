import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { installments, saleItems, sales } from "@/server/db/schema";
import { ValidationError } from "@/server/errors";
import { INSTALLMENTS_OVER_LIMIT } from "@/server/modules/installments/installments.service";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, getSale, updateSale } from "@/server/modules/sales/sales.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourseWithCost } from "../support/sales";

/**
 * Teto técnico de parcelas numa venda ANTIGA, acima dele: o teto só vale quando
 * a quantidade muda. Só neste arquivo o teto é reduzido a 5 (vi.mock), para não
 * refazer cronogramas de mais de 1.000 parcelas — o gatilho do 006 confere o
 * cronograma inteiro a cada parcela gravada, o que fica caro no PGlite. O teto
 * real (1.000 aceito, 1.001 recusado) é testado em installments.test.ts.
 */
const { TEST_LIMIT } = vi.hoisted(() => ({ TEST_LIMIT: 5 }));
vi.mock("@/lib/installments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/installments")>()),
  MAX_INSTALLMENTS: TEST_LIMIT,
}));

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let seq = 0;
const ctx = (userId: string) => org.ctx(userId);
const overLimit = { fieldErrors: { installmentCount: [INSTALLMENTS_OVER_LIMIT] } };

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 4_000);
});
afterAll(() => handle.close());

async function newSale(count: number, prices: number[]): Promise<string> {
  const lead = await createLead(await ctx(org.ids.sellerA1), { name: `Cliente Antigo ${++seq}`, phone: `(79) 95${String(seq).padStart(7, "0")}`, interestCourseId: course });
  return (
    await createSale(await ctx(org.ids.admin), {
      requestId: crypto.randomUUID(),
      leadId: lead.id,
      sellerId: org.ids.sellerA1,
      saleDate: "2026-03-15",
      paymentMethod: "CARD",
      installmentCount: count,
      items: prices.map((priceCents) => ({ courseId: course, priceCents })),
    })
  ).saleId;
}

/**
 * Venda registrada antes do teto: leva a quantidade além dele direto no banco
 * de teste, pelo mesmo caminho que o banco audita e confere no COMMIT
 * (cronograma refeito pela regra do 006 + evento UPDATED calculado pelo banco).
 */
async function makeLegacy(saleId: string, count: number) {
  await handle.db.transaction(async (tx) => {
    await tx.execute(sql`update installments set status = 'CANCELED', replaced_at = now() where sale_id = ${saleId} and replaced_at is null`);
    await tx.execute(sql`update sales set installment_count = ${count} where id = ${saleId}`);
    await tx.execute(sql`
      insert into installments (sale_id, number, amount_cents, due_date, status)
      select s.id, g.n,
             case when g.n = 1 then s.total_cents - (s.installment_count - 1) * (s.total_cents / s.installment_count)
                  else s.total_cents / s.installment_count end,
             (s.sale_date + make_interval(months => g.n))::date, 'OPEN'
        from sales s cross join lateral generate_series(1, s.installment_count) as g(n)
       where s.id = ${saleId}`);
    await tx.execute(sql`insert into sale_events (sale_id, type, actor_id) values (${saleId}, 'UPDATED', ${org.ids.admin})`);
  });
}

const version = async (saleId: string) => (await getSale(await ctx(org.ids.admin), saleId)).version;
/** Retrato direto do banco: venda, todos os itens (inclusive removidos), todas as parcelas (inclusive substituídas) e versão. */
const saleState = async (saleId: string) => ({
  sale: (
    await handle.db
      .select({ sellerId: sales.sellerId, totalCents: sales.totalCents, installmentCount: sales.installmentCount, status: sales.status })
      .from(sales)
      .where(eq(sales.id, saleId))
  )[0],
  items: await handle.db
    .select({ id: saleItems.id, priceCents: saleItems.priceCents, removedAt: saleItems.removedAt })
    .from(saleItems)
    .where(eq(saleItems.saleId, saleId))
    .orderBy(asc(saleItems.id)),
  installments: await handle.db.select().from(installments).where(eq(installments.saleId, saleId)).orderBy(asc(installments.id)),
  version: await version(saleId),
});
const current = (state: Awaited<ReturnType<typeof saleState>>) => state.installments.filter((p) => p.replacedAt === null);

describe(`venda antiga acima do teto técnico (teto reduzido a ${TEST_LIMIT} só neste arquivo)`, () => {
  it("o teto reduzido vale no serviço (a criação acima dele é recusada); a constante real não muda", async () => {
    const actual = await vi.importActual<typeof import("@/lib/installments")>("@/lib/installments");
    expect(actual.MAX_INSTALLMENTS).toBe(1_000);
    await expect(newSale(TEST_LIMIT + 1, [100_000])).rejects.toMatchObject(overLimit);
  });

  it("edições que não mudam a quantidade continuam permitidas e são gravadas; mudar a quantidade respeita o teto", async () => {
    const legacyCount = TEST_LIMIT + 2;
    const saleId = await newSale(3, [60_000, 40_000]);
    await makeLegacy(saleId, legacyCount);
    const start = await saleState(saleId);
    expect(start.sale).toMatchObject({ totalCents: 100_000, installmentCount: legacyCount });
    expect(current(start)).toHaveLength(legacyCount);
    const supervisor = await ctx(org.ids.supA);

    // 1) Troca de responsável: gravada, sem mexer nas parcelas.
    await updateSale(supervisor, saleId, { expectedVersion: start.version, sellerId: org.ids.sellerA2 });
    const afterSeller = await saleState(saleId);
    expect(afterSeller.sale).toMatchObject({ sellerId: org.ids.sellerA2, totalCents: 100_000, installmentCount: legacyCount });
    expect(afterSeller.installments).toEqual(start.installments);
    expect(afterSeller.version).toBeGreaterThan(start.version);

    // 2) O formulário reenvia a mesma quantidade junto de uma correção de preço:
    //    preço e total gravados; cronograma refeito com a quantidade antiga; o anterior fica como histórico.
    const item = afterSeller.items.find((i) => i.priceCents === 60_000)!;
    await updateSale(supervisor, saleId, {
      expectedVersion: afterSeller.version,
      installmentCount: legacyCount,
      repriceItems: [{ itemId: item.id, priceCents: 61_000 }],
    });
    const afterReprice = await saleState(saleId);
    expect(afterReprice.sale).toMatchObject({ totalCents: 101_000, installmentCount: legacyCount });
    expect(afterReprice.items.find((i) => i.id === item.id)).toMatchObject({ priceCents: 61_000, removedAt: null });
    expect(current(afterReprice)).toHaveLength(legacyCount);
    expect(current(afterReprice).reduce((sum, p) => sum + p.amountCents, 0)).toBe(101_000);
    expect(afterReprice.installments.filter((p) => p.replacedAt !== null)).toHaveLength(3 + legacyCount);

    // 3) Mudar a quantidade para outro valor ainda acima do teto (mesmo para menos): recusado, nada muda.
    for (const installmentCount of [legacyCount - 1, legacyCount + 1]) {
      const error = await updateSale(supervisor, saleId, { expectedVersion: afterReprice.version, installmentCount }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject(overLimit);
      expect(await saleState(saleId)).toEqual(afterReprice);
    }

    // 4) Trazer a quantidade para dentro do teto é aceito.
    await updateSale(supervisor, saleId, { expectedVersion: afterReprice.version, installmentCount: TEST_LIMIT });
    const final = await saleState(saleId);
    expect(final.sale.installmentCount).toBe(TEST_LIMIT);
    expect(current(final)).toHaveLength(TEST_LIMIT);
  });
});
