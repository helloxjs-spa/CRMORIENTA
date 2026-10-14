import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadActor } from "@/server/auth/session";
import type { ServiceContext } from "@/server/context";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, getSale, reverseSale, updateSale } from "@/server/modules/sales/sales.service";
import {
  createRealPgDatabase,
  gate,
  lockWaiters,
  outcomeName,
  REAL_PG_URL,
  runMigrationFile,
  sqlState,
  track,
  waitUntil,
  type RealPgDatabase,
} from "../support/real-pg";

/**
 * Migration 004 em PostgreSQL REAL (CRM_TEST_PG_URL): aplicação do zero, guard
 * de banco vazio, reaplicação, garantias no COMMIT e concorrência de preços.
 */

const MIGRATION_004 = "004_sale_item_prices.sql";
const COURSE = "c0000000-0000-4000-8000-000000000006";

let db: RealPgDatabase;
let monitor: Client;
let seq = 0;

beforeAll(async () => {
  if (!REAL_PG_URL) return;
  db = await createRealPgDatabase();
  monitor = await db.client("crm-test-monitor");
  await monitor.query(`INSERT INTO courses (id, name, institution_name) VALUES ($1, 'Pedagogia', 'Faculdade Teste')`, [COURSE]);
  await monitor.query(`INSERT INTO course_costs (course_id, cost_cents) VALUES ($1, 40000)`, [COURSE]);
}, 120_000);

afterAll(async () => {
  if (!REAL_PG_URL) return;
  await monitor?.end();
  await db?.drop();
});

async function insertUser(c: Client, role: "ADMIN" | "SUPERVISOR" | "SELLER", teamId: string | null = null): Promise<string> {
  const n = ++seq;
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, team_id) VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
    [`U${n}`, `p${n}@conc.local`, role, teamId],
  );
  return rows[0].id;
}

async function insertTeam(c: Client, supervisorId: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(`INSERT INTO teams (name, supervisor_id) VALUES ($1, $2) RETURNING id`, [`Equipe ${++seq}`, supervisorId]);
  return rows[0].id;
}

async function ctx(userId: string): Promise<ServiceContext> {
  const actor = await loadActor(db.handle.db, userId);
  if (!actor) throw new Error("ator inválido");
  return { db: db.handle.db, actor };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "",
    (error: unknown) => String((error as Error).message),
  );
}

/** Venda (serviço) com os preços informados; devolve ids e itens. */
async function soldScenario(prices: number[]) {
  const supervisor = await insertUser(monitor, "SUPERVISOR");
  const teamId = await insertTeam(monitor, supervisor);
  const seller = await insertUser(monitor, "SELLER", teamId);
  const phone = `5579${String(940000000 + ++seq).slice(0, 9)}`;
  const leadId = (await createLead(await ctx(seller), { name: `Lead ${seq}`, phone, interestCourseId: COURSE })).id;
  const saleId = randomUUID();
  await createSale(await ctx(seller), {
    requestId: saleId,
    leadId,
    paymentMethod: "PIX",
    items: prices.map((priceCents) => ({ courseId: COURSE, priceCents })),
  });
  const items = (await monitor.query<{ id: string; price_cents: number }>(`SELECT id, price_cents FROM sale_items WHERE sale_id = $1`, [saleId])).rows;
  return { supervisor, seller, leadId, saleId, items, admin: await insertUser(monitor, "ADMIN") };
}

const version = async (saleId: string) => (await getSale(await ctx(await insertUser(monitor, "ADMIN")), saleId)).version;
const waiting = async (n: number) => (await lockWaiters(monitor)).length >= n;
const blockedBy = async (pid: number) => (await lockWaiters(monitor)).some((w) => w.blockedBy.includes(pid));
const saleTotal = async (saleId: string) => (await monitor.query(`SELECT total_cents FROM sales WHERE id = $1`, [saleId])).rows[0].total_cents as number;
const itemsSum = async (saleId: string) =>
  Number((await monitor.query(`SELECT coalesce(sum(price_cents), 0) s FROM sale_items WHERE sale_id = $1 AND removed_at IS NULL`, [saleId])).rows[0].s);
const eventTypes = async (saleId: string) => (await monitor.query(`SELECT type FROM sale_events WHERE sale_id = $1 ORDER BY id`, [saleId])).rows.map((r) => r.type);

describe.skipIf(!REAL_PG_URL)("migration 004 em PostgreSQL real", () => {
  it("001–004 aplicadas do zero: preço obrigatório, retrato com preço e verificação do total instaladas", async () => {
    const { rows } = await monitor.query(`
      SELECT (SELECT is_nullable FROM information_schema.columns WHERE table_name = 'sale_items' AND column_name = 'price_cents') AS nullable,
             (SELECT column_default FROM information_schema.columns WHERE table_name = 'sale_items' AND column_name = 'price_cents') AS dflt,
             pg_get_functiondef('public.sale_item_snapshot(public.sale_items)'::regprocedure) LIKE '%priceCents%' AS snapshot_has_price,
             pg_get_functiondef('public.sale_commit_check()'::regprocedure) LIKE '%assert_sale_total%' AS commit_checks_total,
             has_function_privilege('anon', 'public.assert_sale_total(uuid)', 'EXECUTE') AS anon_exec,
             (SELECT prosecdef FROM pg_proc WHERE oid = 'public.sale_item_before_write()'::regprocedure) AS security_definer`);
    expect(rows[0]).toEqual({
      nullable: "NO",
      dflt: null,
      snapshot_has_price: true,
      commit_checks_total: true,
      anon_exec: false,
      security_definer: false,
    });
  });

  it("guard: com uma venda já gravada sob o 003, a 004 aborta e nada muda", async () => {
    const legacy = await createRealPgDatabase({ lastMigration: "003_sales.sql" });
    const c = await legacy.client("crm-test-guard");
    try {
      const supervisor = await insertUser(c, "SUPERVISOR");
      const teamId = await insertTeam(c, supervisor);
      const seller = await insertUser(c, "SELLER", teamId);
      const course = randomUUID();
      await c.query(`INSERT INTO courses (id, name, institution_name) VALUES ($1, 'Curso', 'Inst')`, [course]);
      await c.query(`INSERT INTO course_costs (course_id, cost_cents) VALUES ($1, 1000)`, [course]);
      const lead = randomUUID();
      const sale = randomUUID();
      await c.query("BEGIN");
      await c.query(
        `INSERT INTO leads (id, name, phone, interest_course_id, owner_id, team_id, created_by, stage)
         VALUES ($1, 'Lead antigo', '5579912345678', $2, $3, $4, $3, 'CLOSED')`,
        [lead, course, seller, teamId],
      );
      await c.query(
        `INSERT INTO lead_cycles (lead_id, number, kind, assigned_seller_id, team_id, started_by, ended_at, ended_by, end_reason)
         VALUES ($1, 1, 'INITIAL', $2, $3, $2, now(), $2, 'WON')`,
        [lead, seller, teamId],
      );
      await c.query(
        `INSERT INTO sales (id, lead_id, seller_id, team_id, supervisor_id, sale_date, total_cents, payment_method, created_by)
         VALUES ($1, $2, $3, $4, $5, current_date, 5000, 'PIX', $3)`,
        [sale, lead, seller, teamId, supervisor],
      );
      await c.query(
        `INSERT INTO sale_items (sale_id, course_id, cost_snapshot_cents, commission_snapshot_cents, added_by) VALUES ($1, $2, 1000, 10000, $3)`,
        [sale, course, seller],
      );
      await c.query(`INSERT INTO sale_events (sale_id, type, actor_id) VALUES ($1, 'CREATED', $2)`, [sale, seller]);
      await c.query("COMMIT");

      const error = await failure(runMigrationFile(c, MIGRATION_004));
      expect(error).toContain("existem vendas ou itens de venda");
      await c.query("ROLLBACK").catch(() => {});
      const { rows } = await c.query(`
        SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'sale_items' AND column_name LIKE 'price%') AS price_columns,
               pg_get_functiondef('public.sale_item_snapshot(public.sale_items)'::regprocedure) LIKE '%priceCents%' AS snapshot_changed,
               to_regprocedure('public.assert_sale_total(uuid)') IS NULL AS no_total_function,
               (SELECT count(*)::int FROM sale_items) AS items`);
      expect(rows[0]).toEqual({ price_columns: 0, snapshot_changed: false, no_total_function: true, items: 1 });
    } finally {
      await c.end();
      await legacy.drop();
    }
  });

  it("reaplicar a 004 é recusado sem efeito", async () => {
    const c = await db.client("crm-test-reapply");
    try {
      expect(await failure(runMigrationFile(c, MIGRATION_004))).toContain("esta migration já foi aplicada");
      await c.query("ROLLBACK").catch(() => {});
      const { rows } = await c.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'sale_items' AND column_name = 'price_cents'`);
      expect(rows[0].n).toBe(1);
    } finally {
      await c.end();
    }
  });

  it("UPDATE direto de total incompatível e correção de preço sem evento são recusados no COMMIT", async () => {
    const { saleId, items, admin } = await soldScenario([100_000]);
    const c = await db.client("crm-test-direct");
    try {
      await c.query("BEGIN");
      await c.query(`UPDATE sales SET total_cents = total_cents + 1 WHERE id = $1`, [saleId]);
      await c.query(`INSERT INTO sale_events (sale_id, type, actor_id) VALUES ($1, 'UPDATED', $2)`, [saleId, admin]);
      expect(await failure(c.query("COMMIT"))).toContain("diferente da soma dos preços");

      await c.query("BEGIN");
      await c.query(`UPDATE sale_items SET price_cents = 90000 WHERE id = $1`, [items[0].id]);
      await c.query(`UPDATE sales SET total_cents = 90000 WHERE id = $1`, [saleId]);
      expect(await failure(c.query("COMMIT"))).toContain("sem o evento UPDATED");
    } finally {
      await c.end();
    }
    expect([await saleTotal(saleId), await itemsSum(saleId)]).toEqual([100_000, 100_000]);
    expect(await eventTypes(saleId)).toEqual(["CREATED"]);
  });

  it("inclusões concorrentes por SQL direto: a segunda, com total calculado antes da espera, é recusada no COMMIT", async () => {
    const { saleId, admin } = await soldScenario([100_000]);
    const a = await db.client("crm-test-a");
    const b = await db.client("crm-test-b");
    try {
      const insertItem = (c: Client, price: number) =>
        c.query(
          `INSERT INTO sale_items (sale_id, course_id, price_cents, cost_snapshot_cents, commission_snapshot_cents, added_by)
           VALUES ($1, $2, $3, 40000, 10000, $4)`,
          [saleId, COURSE, price, admin],
        );
      await a.query("BEGIN");
      await insertItem(a, 10_000);
      await b.query("BEGIN");
      const bInsert = track(insertItem(b, 20_000)); // espera a trava da venda (o item "toca" a venda)
      await waitUntil(() => waiting(1), "B esperando a venda");
      await a.query(`UPDATE sales SET total_cents = 110000 WHERE id = $1`, [saleId]);
      await a.query(`INSERT INTO sale_events (sale_id, type, actor_id) VALUES ($1, 'UPDATED', $2)`, [saleId, admin]);
      await a.query("COMMIT");
      expect(outcomeName(await bInsert.promise)).toBe("ok");
      // B calculou o total com o valor que viu antes de esperar (100.000 + 20.000).
      await b.query(`UPDATE sales SET total_cents = 120000 WHERE id = $1`, [saleId]);
      await b.query(`INSERT INTO sale_events (sale_id, type, actor_id) VALUES ($1, 'UPDATED', $2)`, [saleId, admin]);
      const error = await b.query("COMMIT").then(
        () => null,
        (e: unknown) => e,
      );
      expect(String((error as Error).message)).toContain("diferente da soma dos preços");
      expect(sqlState(error)).toBe("P0001");
    } finally {
      await a.end();
      await b.end();
    }
    expect([await saleTotal(saleId), await itemsSum(saleId)]).toEqual([110_000, 110_000]);
  });
});

describe.skipIf(!REAL_PG_URL)("concorrência real: preços pelos serviços", () => {
  it("correção × correção do mesmo item (mesma versão): uma vale, a outra recebe conflito; um único itemsRepriced", async () => {
    const { saleId, items, supervisor, admin } = await soldScenario([100_000, 50_000]);
    const target = items.find((i) => i.price_cents === 100_000)!;
    const v = await version(saleId);
    // Para a primeira correção ao gravar o preço do item (já com lead e venda travados).
    const g = await gate(db, `SELECT 1 FROM sale_items WHERE id = $1 FOR UPDATE`, [target.id]);
    const first = track(updateSale(await ctx(supervisor), saleId, { expectedVersion: v, repriceItems: [{ itemId: target.id, priceCents: 90_000 }] }));
    await waitUntil(() => blockedBy(g.pid), "primeira correção parada no portão");
    const second = track(updateSale(await ctx(admin), saleId, { expectedVersion: v, repriceItems: [{ itemId: target.id, priceCents: 80_000 }] }));
    await waitUntil(() => waiting(2), "segunda correção esperando o lead");
    await g.release();

    expect([outcomeName(await first.promise), outcomeName(await second.promise)]).toEqual(["ok", "ConflictError"]);
    expect([await saleTotal(saleId), await itemsSum(saleId)]).toEqual([140_000, 140_000]);
    const { rows } = await monitor.query(`SELECT metadata FROM sale_events WHERE sale_id = $1 AND type = 'UPDATED'`, [saleId]);
    expect(rows.map((r) => r.metadata.itemsRepriced)).toEqual([[{ id: target.id, courseId: COURSE, from: 100_000, to: 90_000 }]]);
  });

  it("correção de preço × estorno: a correção conclui; o estorno com a versão antiga recebe conflito", async () => {
    const { saleId, items, supervisor, admin } = await soldScenario([100_000, 50_000]);
    const target = items.find((i) => i.price_cents === 50_000)!;
    const v = await version(saleId);
    const g = await gate(db, `SELECT 1 FROM sale_items WHERE id = $1 FOR UPDATE`, [target.id]);
    const reprice = track(updateSale(await ctx(supervisor), saleId, { expectedVersion: v, repriceItems: [{ itemId: target.id, priceCents: 55_000 }] }));
    await waitUntil(() => blockedBy(g.pid), "correção parada no portão");
    const reverse = track(reverseSale(await ctx(admin), saleId, { expectedVersion: v, reason: "Teste" }));
    await waitUntil(() => waiting(2), "estorno esperando o lead");
    await g.release();

    expect([outcomeName(await reprice.promise), outcomeName(await reverse.promise)]).toEqual(["ok", "ConflictError"]);
    expect(await eventTypes(saleId)).toEqual(["CREATED", "UPDATED"]);
    expect([await saleTotal(saleId), await itemsSum(saleId)]).toEqual([155_000, 155_000]);
  });

  it("remoção (supervisor) × inclusão (vendedor) concorrentes na mesma versão: uma vale, a outra recebe conflito; total coerente", async () => {
    const { saleId, items, supervisor, seller } = await soldScenario([100_000, 50_000]);
    const target = items.find((i) => i.price_cents === 100_000)!;
    const v = await version(saleId);
    const g = await gate(db, `SELECT 1 FROM sale_items WHERE id = $1 FOR UPDATE`, [target.id]);
    const remove = track(updateSale(await ctx(supervisor), saleId, { expectedVersion: v, removeItemIds: [target.id] }));
    await waitUntil(() => blockedBy(g.pid), "remoção parada no portão");
    const add = track(updateSale(await ctx(seller), saleId, { expectedVersion: v, addItems: [{ courseId: COURSE, priceCents: 7_000 }] }));
    await waitUntil(() => waiting(2), "inclusão esperando o lead");
    await g.release();

    expect([outcomeName(await remove.promise), outcomeName(await add.promise)]).toEqual(["ok", "ConflictError"]);
    expect([await saleTotal(saleId), await itemsSum(saleId)]).toEqual([50_000, 50_000]);
  });
});
