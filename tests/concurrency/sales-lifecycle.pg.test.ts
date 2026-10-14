import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadActor } from "@/server/auth/session";
import type { ServiceContext } from "@/server/context";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, getSale, reactivateSale, reverseSale, updateSale } from "@/server/modules/sales/sales.service";
import { changeSellerTeam, setUserActive } from "@/server/modules/users/users.service";
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
 * Concorrência REAL (PostgreSQL local, CRM_TEST_PG_URL) de edição, estorno e
 * reativação de venda, entre si e com desativação/troca de equipe de vendedor.
 */

let db: RealPgDatabase;
let monitor: Client;
let seq = 0;
const COURSE = "c0000000-0000-4000-8000-000000000004";
const COURSE2 = "c0000000-0000-4000-8000-000000000005";

beforeAll(async () => {
  if (!REAL_PG_URL) return;
  db = await createRealPgDatabase();
  monitor = await db.client("crm-test-monitor");
  for (const [id, name] of [[COURSE, "Pedagogia"], [COURSE2, "Administração"]]) {
    await monitor.query(`INSERT INTO courses (id, name, institution_name) VALUES ($1, $2, 'Faculdade Teste')`, [id, name]);
    await monitor.query(`INSERT INTO course_costs (course_id, cost_cents) VALUES ($1, 40000)`, [id]);
  }
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
    [`U${n}`, `l${n}@conc.local`, role, teamId],
  );
  return rows[0].id;
}

async function insertTeam(supervisorId: string): Promise<string> {
  const { rows } = await monitor.query<{ id: string }>(`INSERT INTO teams (name, supervisor_id) VALUES ($1, $2) RETURNING id`, [
    `Equipe ${++seq}`,
    supervisorId,
  ]);
  return rows[0].id;
}

async function ctx(userId: string): Promise<ServiceContext> {
  const actor = await loadActor(db.handle.db, userId);
  if (!actor) throw new Error("ator inválido");
  return { db: db.handle.db, actor };
}

/** Equipe com supervisor e vendedor; lead do vendedor com `sales` vendas dele. */
async function scenario(salesCount = 1) {
  const supervisor = await insertUser("SUPERVISOR");
  const teamId = await insertTeam(supervisor);
  const seller = await insertUser("SELLER", teamId);
  const phone = `5579${String(930000000 + ++seq).slice(0, 9)}`;
  const leadId = (await createLead(await ctx(seller), { name: `Lead ${seq}`, phone, interestCourseId: COURSE })).id;
  const saleIds: string[] = [];
  for (let i = 0; i < salesCount; i++) {
    const requestId = randomUUID();
    await createSale(await ctx(seller), { requestId, leadId, paymentMethod: "PIX", items: [{ courseId: COURSE, priceCents: 150_000 }] });
    saleIds.push(requestId);
  }
  return { supervisor, teamId, seller, leadId, saleIds, admin: await insertUser("ADMIN") };
}

const version = async (saleId: string) => (await getSale(await ctx(await insertUser("ADMIN")), saleId)).version;
const waiting = async (n: number) => (await lockWaiters(monitor)).length >= n;
const blockedBy = async (pid: number) => (await lockWaiters(monitor)).some((w) => w.blockedBy.includes(pid));
const eventTypes = async (saleId: string) =>
  (await monitor.query(`SELECT type FROM sale_events WHERE sale_id = $1 ORDER BY id`, [saleId])).rows.map((r) => r.type);
const leadEventTypes = async (leadId: string) =>
  (await monitor.query(`SELECT type FROM lead_events WHERE lead_id = $1 ORDER BY id`, [leadId])).rows.map((r) => r.type);
const leadState = async (leadId: string) => (await monitor.query(`SELECT owner_id, team_id, stage, status FROM leads WHERE id = $1`, [leadId])).rows[0];
const saleState = async (saleId: string) => (await monitor.query(`SELECT seller_id, team_id, supervisor_id, status FROM sales WHERE id = $1`, [saleId])).rows[0];

/** Nenhum lead em operação com responsável inativo ou de outra equipe (invariante do 002). */
async function openLeadViolations(leadId: string): Promise<number> {
  const { rows } = await monitor.query(
    `SELECT count(*)::int n FROM leads l JOIN users u ON u.id = l.owner_id
      WHERE l.id = $1 AND l.status = 'ACTIVE' AND l.stage <> 'CLOSED' AND (NOT u.active OR u.team_id IS DISTINCT FROM l.team_id)`,
    [leadId],
  );
  return rows[0].n;
}

/** Portão no ciclo encerrado do lead: para o estorno ao gravar SALE_REVERSED (FK do ciclo), com tudo travado. */
const wonCycleGate = (leadId: string) =>
  gate(db, `SELECT 1 FROM lead_cycles WHERE lead_id = $1 AND end_reason = 'WON' FOR UPDATE`, [leadId]);

describe.skipIf(!REAL_PG_URL)("concorrência real: edição, estorno e reativação", () => {
  it("estorno × estorno da mesma venda (mesma versão): um estorna, o outro recebe conflito; um único REVERSED", async () => {
    const { supervisor, leadId, saleIds, admin } = await scenario(2);
    const v = await version(saleIds[0]);
    const g = await wonCycleGate(leadId);
    const first = track(reverseSale(await ctx(supervisor), saleIds[0], { expectedVersion: v, reason: "A" }));
    await waitUntil(() => blockedBy(g.pid), "primeiro estorno parado no portão");
    const second = track(reverseSale(await ctx(admin), saleIds[0], { expectedVersion: v, reason: "B" }));
    await waitUntil(() => waiting(2), "segundo estorno esperando o lead");
    await g.release();

    expect([outcomeName(await first.promise), outcomeName(await second.promise)]).toEqual(["ok", "ConflictError"]);
    expect(await eventTypes(saleIds[0])).toEqual(["CREATED", "REVERSED"]);
    expect((await leadEventTypes(leadId)).filter((t) => t === "SALE_REVERSED")).toHaveLength(1);
    expect(await leadState(leadId)).toMatchObject({ stage: "CLOSED" });
  });

  it("edição de itens × estorno (edição primeiro): a edição conclui; o estorno com a versão antiga recebe conflito", async () => {
    const { supervisor, seller, leadId, saleIds } = await scenario(1);
    const v = await version(saleIds[0]);
    // Para a edição ao travar o custo do curso incluído (depois de travar lead e venda).
    const g = await gate(db, `SELECT 1 FROM course_costs WHERE course_id = $1 FOR UPDATE`, [COURSE2]);
    const edit = track(updateSale(await ctx(seller), saleIds[0], { expectedVersion: v, addItems: [{ courseId: COURSE2, priceCents: 150_000 }] }));
    await waitUntil(() => blockedBy(g.pid), "edição parada no portão");
    const reverse = track(reverseSale(await ctx(supervisor), saleIds[0], { expectedVersion: v, reason: "Teste" }));
    await waitUntil(() => waiting(2), "estorno esperando o lead");
    await g.release();

    expect([outcomeName(await edit.promise), outcomeName(await reverse.promise)]).toEqual(["ok", "ConflictError"]);
    expect(await eventTypes(saleIds[0])).toEqual(["CREATED", "UPDATED"]);
    expect(await saleState(saleIds[0])).toMatchObject({ status: "ACTIVE" });
    expect(await leadState(leadId)).toMatchObject({ stage: "CLOSED" });
  });

  it("estorno da última venda × desativação do responsável (desativação primeiro): reabre na fila do supervisor", async () => {
    const { seller, leadId, saleIds, admin } = await scenario(1);
    const v = await version(saleIds[0]);
    await monitor.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [`s${++seq}`, seller]);
    const g = await gate(db, `SELECT 1 FROM sessions WHERE user_id = $1 FOR UPDATE`, [seller]);
    const deactivate = track(setUserActive(await ctx(admin), seller, false));
    await waitUntil(() => blockedBy(g.pid), "desativação parada no portão");
    const reverse = track(reverseSale(await ctx(await insertUser("ADMIN")), saleIds[0], { expectedVersion: v, reason: "Teste" }));
    await waitUntil(() => waiting(2), "estorno esperando o vendedor");
    await g.release();

    expect([outcomeName(await deactivate.promise), outcomeName(await reverse.promise)]).toEqual(["ok", "ok"]);
    expect(await leadState(leadId)).toMatchObject({ stage: "NEW", owner_id: null });
    expect((await leadEventTypes(leadId)).slice(-2)).toEqual(["SALE_REVERSED", "UNASSIGNED"]);
    expect(await openLeadViolations(leadId)).toBe(0);
  });

  it("estorno da última venda × desativação do responsável (estorno primeiro): reabre com ele e a desativação o tira", async () => {
    const { supervisor, seller, leadId, saleIds, admin } = await scenario(1);
    const v = await version(saleIds[0]);
    // Para o estorno ao gravar SALE_REVERSED (FK do supervisor da equipe), com o lead já reaberto.
    const g = await gate(db, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [supervisor]);
    const reverse = track(reverseSale(await ctx(admin), saleIds[0], { expectedVersion: v, reason: "Teste" }));
    await waitUntil(() => blockedBy(g.pid), "estorno parado no portão");
    const deactivate = track(setUserActive(await ctx(await insertUser("ADMIN")), seller, false));
    await waitUntil(() => waiting(2), "desativação esperando o estorno");
    await g.release();

    expect([outcomeName(await reverse.promise), outcomeName(await deactivate.promise)]).toEqual(["ok", "ok"]);
    expect(await leadState(leadId)).toMatchObject({ stage: "NEW", owner_id: null });
    expect((await leadEventTypes(leadId)).slice(-2)).toEqual(["SALE_REVERSED", "UNASSIGNED"]);
    expect(await openLeadViolations(leadId)).toBe(0);
  });

  it("reativação × desativação do responsável (desativação primeiro): a reativação espera e é recusada", async () => {
    const { supervisor, seller, saleIds, admin } = await scenario(1);
    await reverseSale(await ctx(supervisor), saleIds[0], { expectedVersion: await version(saleIds[0]), reason: "Teste" });
    const v = await version(saleIds[0]);
    await monitor.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [`s${++seq}`, seller]);
    const g = await gate(db, `SELECT 1 FROM sessions WHERE user_id = $1 FOR UPDATE`, [seller]);
    const deactivate = track(setUserActive(await ctx(admin), seller, false));
    await waitUntil(() => blockedBy(g.pid), "desativação parada no portão");
    const reactivate = track(reactivateSale(await ctx(supervisor), saleIds[0], { expectedVersion: v, reason: "Teste" }));
    await waitUntil(() => waiting(2), "reativação esperando o vendedor");
    await g.release();

    expect([outcomeName(await deactivate.promise), outcomeName(await reactivate.promise)]).toEqual(["ok", "ValidationError"]);
    expect(await saleState(saleIds[0])).toMatchObject({ status: "REVERSED" });
    expect(await eventTypes(saleIds[0])).toEqual(["CREATED", "REVERSED"]);
  });

  it("troca de responsável × transferência do novo vendedor de equipe (transferência primeiro): a venda vai para a equipe nova", async () => {
    const { leadId, saleIds, admin } = await scenario(1);
    const supB = await insertUser("SUPERVISOR");
    const teamB = await insertTeam(supB);
    const supC = await insertUser("SUPERVISOR");
    const teamC = await insertTeam(supC);
    const x = await insertUser("SELLER", teamC);
    const v = await version(saleIds[0]);
    // Para a troca de equipe de X depois de travá-lo (equipe destino travada pelo portão).
    const g = await gate(db, `SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, [teamB]);
    const move = track(changeSellerTeam(await ctx(admin), x, { teamId: teamB }));
    await waitUntil(() => blockedBy(g.pid), "troca de equipe parada no portão");
    const change = track(updateSale(await ctx(await insertUser("ADMIN")), saleIds[0], { expectedVersion: v, sellerId: x }));
    await waitUntil(() => waiting(2), "troca de responsável esperando o vendedor");
    await g.release();

    expect([outcomeName(await move.promise), outcomeName(await change.promise)]).toEqual(["ok", "ok"]);
    expect(await saleState(saleIds[0])).toMatchObject({ seller_id: x, team_id: teamB, supervisor_id: supB });
    expect(await leadState(leadId)).toMatchObject({ owner_id: x, team_id: teamB, stage: "CLOSED" });
  });
});
