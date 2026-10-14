import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadActor } from "@/server/auth/session";
import type { ServiceContext } from "@/server/context";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, type CreateSaleResult } from "@/server/modules/sales/sales.service";
import { updateTeam } from "@/server/modules/teams/teams.service";
import { setUserActive } from "@/server/modules/users/users.service";
import {
  createRealPgDatabase,
  gate,
  lockWaiters,
  outcomeName,
  REAL_PG_URL,
  track,
  waitUntil,
  type RealPgDatabase,
} from "../support/real-pg";

/**
 * Concorrência REAL (PostgreSQL local, CRM_TEST_PG_URL) do registro de venda.
 * Portão padrão: FOR UPDATE no custo do curso, que para createSale DEPOIS de
 * travar usuários, equipes e lead (lockCourseCosts) e ANTES de gravar.
 */

let db: RealPgDatabase;
let monitor: Client;
let seq = 0;
const COURSE = "c0000000-0000-4000-8000-000000000003";

beforeAll(async () => {
  if (!REAL_PG_URL) return;
  db = await createRealPgDatabase();
  monitor = await db.client("crm-test-monitor");
  await monitor.query(`INSERT INTO courses (id, name, institution_name) VALUES ('${COURSE}', 'Pedagogia', 'Faculdade Teste')`);
  await monitor.query(`INSERT INTO course_costs (course_id, cost_cents) VALUES ('${COURSE}', 40000)`);
}, 120_000);

afterAll(async () => {
  if (!REAL_PG_URL) return;
  await monitor?.end();
  await db?.drop();
});

async function insertUser(role: "ADMIN" | "SUPERVISOR" | "SELLER", teamId: string | null = null): Promise<string> {
  const n = ++seq;
  const { rows } = await monitor.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, team_id) VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
    [`U${n}`, `v${n}@conc.local`, role, teamId],
  );
  return rows[0].id;
}

async function ctx(userId: string): Promise<ServiceContext> {
  const actor = await loadActor(db.handle.db, userId);
  if (!actor) throw new Error("ator inválido");
  return { db: db.handle.db, actor };
}

async function scenario() {
  const supervisor = await insertUser("SUPERVISOR");
  const { rows } = await monitor.query<{ id: string }>(`INSERT INTO teams (name, supervisor_id) VALUES ($1, $2) RETURNING id`, [
    `Equipe ${++seq}`,
    supervisor,
  ]);
  const teamId = rows[0].id;
  const seller = await insertUser("SELLER", teamId);
  const phone = `5579${String(920000000 + ++seq).slice(0, 9)}`;
  const leadId = (await createLead(await ctx(seller), { name: `Lead ${seq}`, phone, interestCourseId: COURSE })).id;
  return { supervisor, teamId, seller, leadId, admin: await insertUser("ADMIN") };
}

const input = (leadId: string, extra: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  leadId,
  paymentMethod: "PIX",
  items: [{ courseId: COURSE, priceCents: 150_000 }],
  ...extra,
});

const costGate = () => gate(db, `SELECT 1 FROM course_costs WHERE course_id = $1 FOR UPDATE`, [COURSE]);
const waiting = async (n: number) => (await lockWaiters(monitor)).length >= n;
const blockedBy = async (pid: number) => (await lockWaiters(monitor)).some((w) => w.blockedBy.includes(pid));

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await monitor.query(sql, params)).rows[0].n);
}

async function leadState(leadId: string) {
  return (await monitor.query(`SELECT owner_id, stage, status FROM leads WHERE id = $1`, [leadId])).rows[0];
}

describe.skipIf(!REAL_PG_URL)("concorrência real: registro de venda", () => {
  it("duas vendas diferentes no mesmo lead ao mesmo tempo: as duas valem, em fila; ciclo encerrado uma vez", async () => {
    const { seller, leadId } = await scenario();
    const g = await costGate();
    const first = track(createSale(await ctx(seller), input(leadId)));
    await waitUntil(() => blockedBy(g.pid), "primeira venda parada no portão");
    const second = track(createSale(await ctx(seller), input(leadId)));
    await waitUntil(() => waiting(2), "segunda venda esperando o lead");
    await g.release();

    expect([outcomeName(await first.promise), outcomeName(await second.promise)]).toEqual(["ok", "ok"]);
    expect(await count(`SELECT count(*) n FROM sales WHERE lead_id = $1 AND status = 'ACTIVE'`, [leadId])).toBe(2);
    expect(await count(`SELECT count(*) n FROM sale_events e JOIN sales s ON s.id = e.sale_id WHERE s.lead_id = $1 AND e.type = 'CREATED'`, [leadId])).toBe(2);
    expect(await count(`SELECT count(*) n FROM lead_events WHERE lead_id = $1 AND type = 'SALE_CREATED'`, [leadId])).toBe(2);
    expect(await count(`SELECT count(*) n FROM lead_cycles WHERE lead_id = $1 AND end_reason = 'WON'`, [leadId])).toBe(1);
    expect(await leadState(leadId)).toMatchObject({ stage: "CLOSED", owner_id: seller });
  });

  it("a mesma solicitação enviada duas vezes ao mesmo tempo: uma grava, a outra devolve a mesma venda", async () => {
    const { seller, leadId } = await scenario();
    const request = input(leadId);
    const g = await costGate();
    const results: CreateSaleResult[] = [];
    const first = track(createSale(await ctx(seller), request).then((r) => results.push(r)));
    await waitUntil(() => blockedBy(g.pid), "primeira cópia parada no portão");
    const second = track(createSale(await ctx(seller), request).then((r) => results.push(r)));
    await waitUntil(() => waiting(2), "segunda cópia esperando o lead");
    await g.release();

    expect([outcomeName(await first.promise), outcomeName(await second.promise)]).toEqual(["ok", "ok"]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(results.every((r) => r.saleId === request.requestId)).toBe(true);
    expect(await count(`SELECT count(*) n FROM sales WHERE lead_id = $1`, [leadId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM sale_events WHERE sale_id = $1`, [request.requestId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM lead_events WHERE lead_id = $1 AND type = 'SALE_CREATED'`, [leadId])).toBe(1);
  });

  it("venda × desativação do vendedor (desativação primeiro): a venda espera, refaz e é recusada; nada gravado", async () => {
    const { supervisor, seller, leadId, admin } = await scenario();
    await monitor.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [`s${++seq}`, seller]);
    // Para a desativação depois de alterar o vendedor e antes de mexer nos leads dele.
    const g = await gate(db, `SELECT 1 FROM sessions WHERE user_id = $1 FOR UPDATE`, [seller]);
    const deactivate = track(setUserActive(await ctx(admin), seller, false));
    await waitUntil(() => blockedBy(g.pid), "desativação parada no portão");
    const sale = track(createSale(await ctx(supervisor), input(leadId, { sellerId: seller })));
    await waitUntil(() => waiting(2), "venda esperando o vendedor");
    await g.release();

    expect([outcomeName(await deactivate.promise), outcomeName(await sale.promise)]).toEqual(["ok", "ValidationError"]);
    expect(await count(`SELECT count(*) n FROM sales WHERE lead_id = $1`, [leadId])).toBe(0);
    expect(await leadState(leadId)).toMatchObject({ owner_id: null, stage: "NEW" });
  });

  it("venda × desativação do vendedor (venda primeiro): a venda conclui; o lead fechado continua com ele", async () => {
    const { supervisor, seller, leadId, admin } = await scenario();
    const g = await costGate();
    const sale = track(createSale(await ctx(supervisor), input(leadId, { sellerId: seller })));
    await waitUntil(() => blockedBy(g.pid), "venda parada no portão");
    const deactivate = track(setUserActive(await ctx(admin), seller, false));
    await waitUntil(() => waiting(2), "desativação esperando a venda");
    await g.release();

    expect([outcomeName(await sale.promise), outcomeName(await deactivate.promise)]).toEqual(["ok", "ok"]);
    expect(await count(`SELECT count(*) n FROM sales WHERE lead_id = $1 AND status = 'ACTIVE'`, [leadId])).toBe(1);
    expect(await leadState(leadId)).toMatchObject({ owner_id: seller, stage: "CLOSED" });
  });

  it("venda × desativação da equipe (venda primeiro): a desativação espera e é recusada (vendedor ativo)", async () => {
    const { teamId, seller, leadId, admin } = await scenario();
    const g = await costGate();
    const sale = track(createSale(await ctx(seller), input(leadId)));
    await waitUntil(() => blockedBy(g.pid), "venda parada no portão");
    const deactivate = track(updateTeam(await ctx(admin), teamId, { active: false }));
    await waitUntil(async () => deactivate.settled() || (await waiting(2)), "desativação concluída ou esperando");
    await g.release();

    expect([outcomeName(await sale.promise), outcomeName(await deactivate.promise)]).toEqual(["ok", "ConflictError"]);
    expect((await monitor.query(`SELECT active FROM teams WHERE id = $1`, [teamId])).rows[0].active).toBe(true);
  });
});
