import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadActor } from "@/server/auth/session";
import type { ServiceContext } from "@/server/context";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, getSale, updateSale } from "@/server/modules/sales/sales.service";
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
 * Validação final da migration 004 em PostgreSQL REAL (CRM_TEST_PG_URL), por
 * SQL direto com controle explícito das transações: auditoria de correção de
 * preço, isolamento, guard da migration e papel de banco não proprietário.
 * Nenhum cenário depende só de leitura do código: cada um confere estado
 * final, histórico (sale_events) e atomicidade.
 */

const MIGRATION_004 = "004_sale_item_prices.sql";
const COURSE = "c0000000-0000-4000-8000-000000000007";
const COST = 40_000;
const COMMISSION = 10_000;

let db: RealPgDatabase;
let monitor: Client;
let seq = 0;

beforeAll(async () => {
  if (!REAL_PG_URL) return;
  db = await createRealPgDatabase();
  monitor = await db.client("crm-test-monitor");
  await monitor.query(`INSERT INTO courses (id, name, institution_name) VALUES ($1, 'Pedagogia', 'Faculdade Teste')`, [COURSE]);
  await monitor.query(`INSERT INTO course_costs (course_id, cost_cents) VALUES ($1, $2)`, [COURSE, COST]);
}, 120_000);

afterAll(async () => {
  if (!REAL_PG_URL) return;
  await monitor?.end();
  await db?.drop();
});

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

async function insertUser(c: Client, role: "ADMIN" | "SUPERVISOR" | "SELLER", teamId: string | null = null): Promise<string> {
  const n = ++seq;
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, team_id) VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
    [`U${n}`, `a${n}@conc.local`, role, teamId],
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

/** Equipe, vendedor, lead e (opcional) uma venda pelo serviço com os preços dados. */
async function scenario(prices: number[] | null) {
  const supervisor = await insertUser(monitor, "SUPERVISOR");
  const teamId = await insertTeam(monitor, supervisor);
  const seller = await insertUser(monitor, "SELLER", teamId);
  const admin = await insertUser(monitor, "ADMIN");
  const phone = `5579${String(950000000 + ++seq).slice(0, 9)}`;
  const leadId = (await createLead(await ctx(seller), { name: `Lead ${seq}`, phone, interestCourseId: COURSE })).id;
  let saleId = "";
  if (prices) {
    saleId = randomUUID();
    await createSale(await ctx(seller), { requestId: saleId, leadId, paymentMethod: "PIX", items: prices.map((priceCents) => ({ courseId: COURSE, priceCents })) });
  }
  const items = saleId
    ? (await monitor.query<{ id: string; price_cents: number }>(`SELECT id, price_cents FROM sale_items WHERE sale_id = $1`, [saleId])).rows
    : [];
  const byPrice = (price: number) => items.find((i) => i.price_cents === price)!.id;
  return { supervisor, teamId, seller, admin, leadId, saleId, byPrice };
}

type TxResult = { ok: true } | { ok: false; message: string; sqlstate: string | undefined };

/** Executa as instruções numa transação própria (BEGIN … COMMIT); em erro, ROLLBACK. */
async function runTx(statements: [string, unknown[]?][], begin = "BEGIN", c?: Client): Promise<TxResult> {
  const client = c ?? (await db.client("crm-test-tx"));
  try {
    await client.query(begin);
    for (const [text, params] of statements) await client.query(text, params ?? []);
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, message: String((error as Error).message), sqlstate: sqlState(error) };
  } finally {
    if (!c) await client.end();
  }
}

const recalcTotal = (saleId: string): [string, unknown[]] => [
  `UPDATE sales SET total_cents = (SELECT sum(price_cents) FROM sale_items WHERE sale_id = $1 AND removed_at IS NULL) WHERE id = $1`,
  [saleId],
];
const updatedEvent = (saleId: string, actor: string): [string, unknown[]] => [
  `INSERT INTO sale_events (sale_id, type, actor_id) VALUES ($1, 'UPDATED', $2)`,
  [saleId, actor],
];
const reprice = (itemId: string, price: number): [string, unknown[]] => [`UPDATE sale_items SET price_cents = $2 WHERE id = $1`, [itemId, price]];

async function events(saleId: string) {
  return (await monitor.query<{ type: string; metadata: Record<string, unknown> }>(`SELECT type, metadata FROM sale_events WHERE sale_id = $1 ORDER BY id`, [saleId])).rows;
}
async function item(itemId: string) {
  return (await monitor.query(`SELECT * FROM sale_items WHERE id = $1`, [itemId])).rows[0];
}
async function totals(saleId: string) {
  const { rows } = await monitor.query(
    `SELECT s.total_cents AS total, (SELECT coalesce(sum(price_cents), 0)::int FROM sale_items WHERE sale_id = s.id AND removed_at IS NULL) AS sum
       FROM sales s WHERE s.id = $1`,
    [saleId],
  );
  return rows[0] as { total: number; sum: number };
}

// ---------------------------------------------------------------------------
// 1. Auditoria de correção de preço
// ---------------------------------------------------------------------------

describe.skipIf(!REAL_PG_URL)("004 — auditoria de correção de preço (SQL direto)", () => {
  it("A. A → B → C na mesma transação: um único itemsRepriced A → C; custo e comissão intactos", async () => {
    const s = await scenario([100_000, 50_000]);
    const itemId = s.byPrice(100_000);
    const before = await item(itemId);
    const result = await runTx([reprice(itemId, 90_000), reprice(itemId, 80_000), recalcTotal(s.saleId), updatedEvent(s.saleId, s.admin)]);

    expect(result).toEqual({ ok: true });
    expect((await events(s.saleId)).at(-1)).toEqual({
      type: "UPDATED",
      metadata: {
        changes: { totalCents: { from: 150_000, to: 130_000 } },
        itemsAdded: [],
        itemsRemoved: [],
        itemsRepriced: [{ id: itemId, courseId: COURSE, from: 100_000, to: 80_000 }],
      },
    });
    const after = await item(itemId);
    expect([after.price_cents, after.price_tx_base, after.cost_snapshot_cents, after.commission_snapshot_cents]).toEqual([
      80_000,
      100_000,
      before.cost_snapshot_cents,
      before.commission_snapshot_cents,
    ]);
    expect(await totals(s.saleId)).toEqual({ total: 130_000, sum: 130_000 });
  });

  it("B. A → B → A: sem mudança líquida a transação conclui SEM evento; um UPDATED desnecessário é recusado", async () => {
    const s = await scenario([100_000]);
    const itemId = s.byPrice(100_000);
    const eventsBefore = await events(s.saleId);

    expect(await runTx([reprice(itemId, 90_000), reprice(itemId, 100_000)])).toEqual({ ok: true });
    expect(await events(s.saleId)).toEqual(eventsBefore);
    expect((await item(itemId)).price_cents).toBe(100_000);

    const withEvent = await runTx([reprice(itemId, 90_000), reprice(itemId, 100_000), updatedEvent(s.saleId, s.admin)]);
    expect(withEvent).toMatchObject({ ok: false, sqlstate: "P0001" });
    expect((withEvent as { message: string }).message).toContain("não corresponde a nenhuma alteração real");
    expect(await events(s.saleId)).toEqual(eventsBefore);
    expect(await totals(s.saleId)).toEqual({ total: 100_000, sum: 100_000 });
  });

  it("C1. Criação: item incluído com A e corrigido para B na mesma transação → CREATED com B; nada em correção", async () => {
    const s = await scenario(null);
    const saleId = randomUUID();
    const itemId = randomUUID();
    const result = await runTx([
      [
        `INSERT INTO sales (id, lead_id, seller_id, team_id, supervisor_id, sale_date, total_cents, payment_method, created_by)
         VALUES ($1, $2, $3, $4, $5, current_date, 70000, 'PIX', $3)`,
        [saleId, s.leadId, s.seller, s.teamId, s.supervisor],
      ],
      [
        `INSERT INTO sale_items (id, sale_id, course_id, price_cents, cost_snapshot_cents, commission_snapshot_cents, added_by)
         VALUES ($1, $2, $3, 50000, $4, $5, $6)`,
        [itemId, saleId, COURSE, COST, COMMISSION, s.seller],
      ],
      reprice(itemId, 70_000),
      [`UPDATE lead_cycles SET ended_at = now(), ended_by = $2, end_reason = 'WON' WHERE lead_id = $1 AND ended_at IS NULL`, [s.leadId, s.seller]],
      [`UPDATE leads SET stage = 'CLOSED', stage_entered_at = now(), stage_due_at = NULL WHERE id = $1`, [s.leadId]],
      [`INSERT INTO sale_events (sale_id, type, actor_id) VALUES ($1, 'CREATED', $2)`, [saleId, s.seller]],
    ]);
    expect(result).toEqual({ ok: true });
    const [created] = await events(saleId);
    expect(created.type).toBe("CREATED");
    expect(created.metadata).toMatchObject({ sale: { totalCents: 70_000 }, items: [{ id: itemId, priceCents: 70_000 }] });
    expect(await item(itemId)).toMatchObject({ price_cents: 70_000, price_changed_txid: null, price_tx_base: null });
  });

  it("C2. Edição: item incluído com A e corrigido para B na mesma transação → itemsAdded com B; itemsRepriced vazio", async () => {
    const s = await scenario([100_000]);
    const itemId = randomUUID();
    const result = await runTx([
      [
        `INSERT INTO sale_items (id, sale_id, course_id, price_cents, cost_snapshot_cents, commission_snapshot_cents, added_by)
         VALUES ($1, $2, $3, 20000, $4, $5, $6)`,
        [itemId, s.saleId, COURSE, COST, COMMISSION, s.admin],
      ],
      reprice(itemId, 25_000),
      recalcTotal(s.saleId),
      updatedEvent(s.saleId, s.admin),
    ]);
    expect(result).toEqual({ ok: true });
    const metadata = (await events(s.saleId)).at(-1)!.metadata as { itemsAdded: { id: string; priceCents: number }[]; itemsRepriced: unknown[]; changes: unknown };
    expect(metadata.itemsAdded.map((i) => [i.id, i.priceCents])).toEqual([[itemId, 25_000]]);
    expect(metadata.itemsRepriced).toEqual([]);
    expect(metadata.changes).toEqual({ totalCents: { from: 100_000, to: 125_000 } });
  });

  it("D. Correção confirmada e remoção em outra transação: itemsRemoved com o preço corrigido e os snapshots originais", async () => {
    const s = await scenario([100_000, 50_000]);
    const itemId = s.byPrice(100_000);
    await updateSale(await ctx(s.supervisor), s.saleId, {
      expectedVersion: (await getSale(await ctx(s.admin), s.saleId)).version,
      repriceItems: [{ itemId, priceCents: 95_000 }],
    });
    const corrected = await item(itemId);

    const result = await runTx([
      [`UPDATE sale_items SET removed_at = now(), removed_by = $2 WHERE id = $1`, [itemId, s.admin]],
      recalcTotal(s.saleId),
      updatedEvent(s.saleId, s.admin),
    ]);
    expect(result).toEqual({ ok: true });
    expect((await events(s.saleId)).at(-1)!.metadata).toMatchObject({
      changes: { totalCents: { from: 145_000, to: 50_000 } },
      itemsRemoved: [{ id: itemId, priceCents: 95_000, costSnapshotCents: COST, commissionSnapshotCents: COMMISSION }],
      itemsRepriced: [],
    });
    const removed = await item(itemId);
    expect(removed.removed_at).not.toBeNull();
    expect([removed.price_cents, removed.price_tx_base, removed.price_changed_txid]).toEqual([
      95_000,
      corrected.price_tx_base,
      corrected.price_changed_txid,
    ]);
  });

  it("E. Nova correção depois de gravar o evento: o banco recusa no COMMIT e nada persiste", async () => {
    const s = await scenario([100_000]);
    const itemId = s.byPrice(100_000);
    const eventsBefore = await events(s.saleId);
    const result = await runTx([reprice(itemId, 90_000), recalcTotal(s.saleId), updatedEvent(s.saleId, s.admin), reprice(itemId, 80_000), recalcTotal(s.saleId)]);
    expect(result).toMatchObject({ ok: false, sqlstate: "P0001" });
    expect((result as { message: string }).message).toContain("não corresponde ao estado final");
    expect(await events(s.saleId)).toEqual(eventsBefore);
    expect((await item(itemId)).price_cents).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// 2. Isolamento e integridade
// ---------------------------------------------------------------------------

describe.skipIf(!REAL_PG_URL)("004 — isolamento e integridade", () => {
  it("READ COMMITTED: correções concorrentes de itens diferentes ficam em fila; cada uma com seu UPDATED; total coerente", async () => {
    const s = await scenario([100_000, 50_000]);
    const [i1, i2] = [s.byPrice(100_000), s.byPrice(50_000)];
    const a = await db.client("crm-test-a");
    const b = await db.client("crm-test-b");
    try {
      await a.query("BEGIN");
      await a.query(...reprice(i1, 90_000));
      await b.query("BEGIN");
      const bReprice = track(b.query(...reprice(i2, 40_000))); // espera a venda ("toque")
      await waitUntil(async () => (await lockWaiters(monitor)).length >= 1, "B esperando a venda");
      await a.query(...recalcTotal(s.saleId));
      await a.query(...updatedEvent(s.saleId, s.admin));
      await a.query("COMMIT");
      expect(outcomeName(await bReprice.promise)).toBe("ok");
      await b.query(...recalcTotal(s.saleId)); // RC: o comando novo enxerga a correção de A
      await b.query(...updatedEvent(s.saleId, s.admin));
      await b.query("COMMIT");
    } finally {
      await a.end();
      await b.end();
    }
    const updates = (await events(s.saleId)).filter((e) => e.type === "UPDATED").map((e) => e.metadata.itemsRepriced);
    expect(updates).toEqual([[{ id: i1, courseId: COURSE, from: 100_000, to: 90_000 }], [{ id: i2, courseId: COURSE, from: 50_000, to: 40_000 }]]);
    expect(await totals(s.saleId)).toEqual({ total: 130_000, sum: 130_000 });
  });

  for (const level of ["REPEATABLE READ", "SERIALIZABLE"]) {
    it(`${level}: correção com snapshot anterior a outra correção confirmada → 40001 e rollback integral`, async () => {
      const s = await scenario([100_000, 50_000]);
      const [i1, i2] = [s.byPrice(100_000), s.byPrice(50_000)];
      const b = await db.client("crm-test-b");
      try {
        await b.query(`BEGIN ISOLATION LEVEL ${level}`);
        await b.query(`SELECT total_cents FROM sales WHERE id = $1`, [s.saleId]); // fixa o snapshot
        expect(await runTx([reprice(i1, 90_000), recalcTotal(s.saleId), updatedEvent(s.saleId, s.admin)])).toEqual({ ok: true });
        const error = await b.query(...reprice(i2, 40_000)).then(
          () => null,
          (e: unknown) => e,
        );
        expect(sqlState(error)).toBe("40001");
        await b.query("ROLLBACK");
      } finally {
        await b.end();
      }
      expect((await item(i2)).price_cents).toBe(50_000);
      expect((await events(s.saleId)).filter((e) => e.type === "UPDATED")).toHaveLength(1);
      expect(await totals(s.saleId)).toEqual({ total: 140_000, sum: 140_000 });
    });
  }

  it("SET CONSTRAINTS ALL IMMEDIATE: a verificação roda no próprio comando e recusa a edição incompleta", async () => {
    const s = await scenario([100_000]);
    const itemId = s.byPrice(100_000);
    const result = await runTx([[`SET CONSTRAINTS ALL IMMEDIATE`], reprice(itemId, 90_000)]);
    expect(result).toMatchObject({ ok: false, sqlstate: "P0001" });
    expect((result as { message: string }).message).toMatch(/sem o evento UPDATED|diferente da soma/);
    expect((await item(itemId)).price_cents).toBe(100_000);
  });

  it("soma acima do limite de INTEGER: recusada no COMMIT, nada persiste", async () => {
    const s = await scenario([100_000, 50_000]);
    const [i1, i2] = [s.byPrice(100_000), s.byPrice(50_000)];
    const result = await runTx([
      reprice(i1, 2_147_483_647),
      reprice(i2, 2_147_483_647),
      [`UPDATE sales SET total_cents = 2147483647 WHERE id = $1`, [s.saleId]],
      updatedEvent(s.saleId, s.admin),
    ]);
    expect(result).toMatchObject({ ok: false, sqlstate: "P0001" });
    expect((result as { message: string }).message).toContain("4294967294");
    expect(await totals(s.saleId)).toEqual({ total: 150_000, sum: 150_000 });
  });

  it("preço sem ajustar o total, e total sem o evento: ambos recusados, nada persiste", async () => {
    const s = await scenario([100_000]);
    const itemId = s.byPrice(100_000);
    const noTotal = await runTx([reprice(itemId, 90_000), updatedEvent(s.saleId, s.admin)]);
    expect((noTotal as { message: string }).message).toContain("diferente da soma");
    const noEvent = await runTx([reprice(itemId, 90_000), recalcTotal(s.saleId)]);
    expect((noEvent as { message: string }).message).toContain("sem o evento UPDATED");
    expect((await item(itemId)).price_cents).toBe(100_000);
    expect((await events(s.saleId)).map((e) => e.type)).toEqual(["CREATED"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Guard da migration
// ---------------------------------------------------------------------------

/** Grava (sem COMMIT) uma venda válida pelas regras do 003, numa transação já aberta. */
async function insertLegacySale(c: Client): Promise<void> {
  const supervisor = await insertUser(c, "SUPERVISOR");
  const teamId = await insertTeam(c, supervisor);
  const seller = await insertUser(c, "SELLER", teamId);
  const course = randomUUID();
  await c.query(`INSERT INTO courses (id, name, institution_name) VALUES ($1, 'Curso', 'Inst')`, [course]);
  await c.query(`INSERT INTO course_costs (course_id, cost_cents) VALUES ($1, 1000)`, [course]);
  const lead = randomUUID();
  const sale = randomUUID();
  await c.query(
    `INSERT INTO leads (id, name, phone, interest_course_id, owner_id, team_id, created_by, stage)
     VALUES ($1, 'Lead antigo', $5, $2, $3, $4, $3, 'CLOSED')`,
    [lead, course, seller, teamId, `5579${String(960000000 + ++seq).slice(0, 9)}`],
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
  await c.query(`INSERT INTO sale_items (sale_id, course_id, cost_snapshot_cents, commission_snapshot_cents, added_by) VALUES ($1, $2, 1000, 10000, $3)`, [
    sale,
    course,
    seller,
  ]);
  await c.query(`INSERT INTO sale_events (sale_id, type, actor_id) VALUES ($1, 'CREATED', $2)`, [sale, seller]);
}

async function structure(c: Client) {
  const { rows } = await c.query(`
    SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'sale_items' AND column_name LIKE 'price%') AS price_columns,
           pg_get_functiondef('public.sale_item_snapshot(public.sale_items)'::regprocedure) LIKE '%priceCents%' AS snapshot_with_price,
           to_regprocedure('public.assert_sale_total(uuid)') IS NOT NULL AS total_function`);
  return rows[0] as { price_columns: number; snapshot_with_price: boolean; total_function: boolean };
}
const UNCHANGED = { price_columns: 0, snapshot_with_price: false, total_function: false };
const APPLIED = { price_columns: 3, snapshot_with_price: true, total_function: true };

async function migrationOutcome(c: Client): Promise<string> {
  try {
    await runMigrationFile(c, MIGRATION_004);
    return "ok";
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    return String((error as Error).message);
  }
}

describe.skipIf(!REAL_PG_URL)("004 — guard da migration", () => {
  for (const ending of ["COMMIT", "ROLLBACK"] as const) {
    it(`venda ainda não confirmada em outra sessão; ela faz ${ending}`, async () => {
      const legacy = await createRealPgDatabase({ lastMigration: "003_sales.sql" });
      const writer = await legacy.client("crm-test-writer");
      const migrator = await legacy.client("crm-test-migrator");
      const watcher = await legacy.client("crm-test-watcher");
      try {
        await writer.query("BEGIN");
        await insertLegacySale(writer);
        const migration = track(migrationOutcome(migrator).then((r) => (r === "ok" ? undefined : Promise.reject(new Error(r)))));
        await waitUntil(async () => (await lockWaiters(watcher)).length >= 1, "migration esperando a trava");
        await writer.query(ending);
        const outcome = await migration.promise;
        if (ending === "COMMIT") {
          expect(outcome.ok).toBe(false);
          expect(String((outcome as { error: Error }).error.message)).toContain("existem vendas ou itens de venda");
          expect(await structure(watcher)).toEqual(UNCHANGED);
        } else {
          expect(outcome).toEqual({ ok: true });
          expect(await structure(watcher)).toEqual(APPLIED);
        }
      } finally {
        await writer.end();
        await migrator.end();
        await watcher.end();
        await legacy.drop();
      }
    });
  }

  it("lock_timeout: com a tabela travada por outra sessão, a migration desiste em ~10 s e nada muda", async () => {
    const legacy = await createRealPgDatabase({ lastMigration: "003_sales.sql" });
    const holder = await legacy.client("crm-test-holder");
    const migrator = await legacy.client("crm-test-migrator");
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE public.sales IN ACCESS SHARE MODE");
      const started = Date.now();
      let state: string | undefined;
      const message = await runMigrationFile(migrator, MIGRATION_004).then(
        () => "ok",
        (error: unknown) => {
          state = sqlState(error);
          return String((error as Error).message);
        },
      );
      await migrator.query("ROLLBACK").catch(() => {});
      expect(message).toContain("lock timeout");
      expect(state).toBe("55P03");
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
      await holder.query("ROLLBACK");
      expect(await structure(holder)).toEqual(UNCHANGED);
    } finally {
      await holder.end();
      await migrator.end();
      await legacy.drop();
    }
  }, 60_000);

  it("duas execuções concorrentes: uma aplica, a outra é recusada como já aplicada; estrutura uma vez só", async () => {
    const legacy = await createRealPgDatabase({ lastMigration: "003_sales.sql" });
    const m1 = await legacy.client("crm-test-m1");
    const m2 = await legacy.client("crm-test-m2");
    const watcher = await legacy.client("crm-test-watcher");
    const g = await gate(legacy, "LOCK TABLE public.sales IN ACCESS SHARE MODE");
    try {
      const first = migrationOutcome(m1);
      const second = migrationOutcome(m2);
      await waitUntil(async () => (await lockWaiters(watcher)).length >= 2, "as duas execuções esperando");
      await g.release();
      const outcomes = (await Promise.all([first, second])).sort();
      expect(outcomes[1]).toBe("ok");
      expect(outcomes[0]).toContain("esta migration já foi aplicada");
      expect(await structure(watcher)).toEqual(APPLIED);
    } finally {
      await m1.end();
      await m2.end();
      await watcher.end();
      await legacy.drop();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Papel de banco não proprietário
// ---------------------------------------------------------------------------

describe.skipIf(!REAL_PG_URL)("004 — segurança com papel não proprietário", () => {
  /** Papel de login temporário com privilégios de tabela (opcionalmente BYPASSRLS); removido ao final. */
  async function withRole(bypassRls: boolean, run: (app: Client, role: string) => Promise<void>): Promise<void> {
    const role = `crm_conc_app_${randomBytes(4).toString("hex")}`;
    await monitor.query(`CREATE ROLE ${role} LOGIN${bypassRls ? " BYPASSRLS" : ""}`);
    await monitor.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await monitor.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await monitor.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    const url = new URL(db.url);
    url.username = role;
    const app = new Client({ connectionString: url.toString() });
    await app.connect();
    try {
      await run(app, role);
    } finally {
      await app.end();
      await monitor.query(`DROP OWNED BY ${role}`);
      await monitor.query(`DROP ROLE ${role}`);
    }
  }

  it("papel comum (sem BYPASSRLS): RLS sem políticas esconde as vendas; nada é lido nem gravado", async () => {
    const s = await scenario([100_000]);
    const itemId = s.byPrice(100_000);
    await withRole(false, async (app) => {
      expect((await app.query(`SELECT count(*)::int AS n FROM sale_items WHERE sale_id = $1`, [s.saleId])).rows[0].n).toBe(0);
      expect((await app.query(...reprice(itemId, 1))).rowCount).toBe(0);
      const insert = await runTx([updatedEvent(s.saleId, s.admin)], "BEGIN", app);
      expect(insert.ok).toBe(false);
    });
    expect((await item(itemId)).price_cents).toBe(100_000);
    expect((await events(s.saleId)).map((e) => e.type)).toEqual(["CREATED"]);
  });

  it("papel BYPASSRLS não proprietário: sem EXECUTE falha fechada; com EXECUTE só o caminho auditado passa; sem atalhos", async () => {
    const s = await scenario([100_000]);
    const itemId = s.byPrice(100_000);
    const valid = (price: number): [string, unknown[]?][] => [reprice(itemId, price), recalcTotal(s.saleId), updatedEvent(s.saleId, s.admin)];
    await withRole(true, async (app, role) => {
      // 1) Sem EXECUTE nas funções chamadas pelos triggers: nem o caminho correto grava.
      const denied = await runTx(valid(90_000), "BEGIN", app);
      expect(denied).toMatchObject({ ok: false, sqlstate: "42501" });
      expect((denied as { message: string }).message).toContain("permission denied for function");
      expect((await item(itemId)).price_cents).toBe(100_000);

      // 2) Com EXECUTE: o caminho auditado passa.
      await monitor.query(`GRANT EXECUTE ON FUNCTION
        public.sale_commercial_state(public.sales), public.sale_item_snapshot(public.sale_items),
        public.sale_expected_event(uuid, public.sale_event_type), public.assert_sale_audited(uuid),
        public.assert_sale_total(uuid), public.assert_lead_sale_state(uuid) TO ${role}`);
      expect(await runTx(valid(90_000), "BEGIN", app)).toEqual({ ok: true });
      expect((await events(s.saleId)).at(-1)!.metadata).toMatchObject({ itemsRepriced: [{ id: itemId, from: 100_000, to: 90_000 }] });

      // 3) Mesmo assim, sem atalhos: sem evento, sem total, desligar triggers, replication role.
      expect(await runTx([reprice(itemId, 80_000), recalcTotal(s.saleId)], "BEGIN", app)).toMatchObject({ ok: false, sqlstate: "P0001" });
      expect(await runTx([reprice(itemId, 80_000), updatedEvent(s.saleId, s.admin)], "BEGIN", app)).toMatchObject({ ok: false, sqlstate: "P0001" });
      expect(await runTx([[`UPDATE sale_items SET cost_snapshot_cents = 1 WHERE id = $1`, [itemId]]], "BEGIN", app)).toMatchObject({ ok: false, sqlstate: "P0001" });
      expect(await runTx([[`ALTER TABLE public.sale_items DISABLE TRIGGER ALL`]], "BEGIN", app)).toMatchObject({ ok: false, sqlstate: "42501" });
      expect(await runTx([[`SET LOCAL session_replication_role = replica`]], "BEGIN", app)).toMatchObject({ ok: false, sqlstate: "42501" });
    });
    expect((await item(itemId)).price_cents).toBe(90_000);
    expect(await totals(s.saleId)).toEqual({ total: 90_000, sum: 90_000 });
  });

  it("anon e authenticated: nenhum privilégio nas tabelas de vendas nem execução de funções do schema public", async () => {
    const { rows } = await monitor.query(`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) r(role),
                      unnest(ARRAY['sales', 'sale_items', 'sale_events']) t(tbl),
                      unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p(priv)
         WHERE has_table_privilege(r.role, 'public.' || t.tbl, p.priv)
        UNION ALL
        SELECT 1 FROM pg_proc, unnest(ARRAY['anon', 'authenticated']) r(role)
         WHERE pronamespace = 'public'::regnamespace AND has_function_privilege(r.role, oid, 'EXECUTE')
      ) x`);
    expect(rows[0].n).toBe(0);
  });
});
