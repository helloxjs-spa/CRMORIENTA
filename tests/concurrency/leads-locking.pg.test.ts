import { sql } from "drizzle-orm";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadActor } from "@/server/auth/session";
import type { ServiceContext } from "@/server/context";
import { connectDatabase } from "@/server/db/connect";
import { runTransaction } from "@/server/db/transaction";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import {
  createLead,
  editLead,
  moveLeadStage,
  redistributeLead,
  restoreLead,
  transferLead,
  trashLead,
} from "@/server/modules/leads/leads.service";
import { changeSellerTeam, setUserActive } from "@/server/modules/users/users.service";
import { createRealPgDatabase, lockWaiters, REAL_PG_URL, waitUntil, type RealPgDatabase } from "../support/real-pg";

/**
 * Concorrência REAL (PostgreSQL local, CRM_TEST_PG_URL) das mutações de lead
 * contra desativação e troca de equipe de vendedor (P11) e entre si.
 *
 * Cada cenário força um interleaving: uma sessão "portão" segura uma trava
 * escolhida para PARAR uma operação num ponto exato; o avanço é detectado
 * consultando pg_stat_activity/pg_blocking_pids (sem atrasos fixos).
 */

let db: RealPgDatabase;
let monitor: Client;
let seq = 0;

beforeAll(async () => {
  if (!REAL_PG_URL) return;
  db = await createRealPgDatabase();
  monitor = await db.client("crm-test-monitor");
  await monitor.query(`INSERT INTO courses (id, name, institution_name) VALUES ('${COURSE}', 'Pedagogia', 'Faculdade Teste')`);
}, 120_000);

afterAll(async () => {
  if (!REAL_PG_URL) return;
  await monitor?.end();
  await db?.drop();
});

const COURSE = "c0000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------------------
// Dados e utilitários
// ---------------------------------------------------------------------------

async function insertUser(role: "ADMIN" | "SUPERVISOR" | "SELLER", teamId: string | null = null, id?: string): Promise<string> {
  const n = ++seq;
  const { rows } = await monitor.query<{ id: string }>(
    `INSERT INTO users (${id ? "id, " : ""}name, email, password_hash, role, team_id)
     VALUES (${id ? "$5, " : ""}$1, $2, 'x', $3, $4) RETURNING id`,
    id ? [`U${n}`, `u${n}@conc.local`, role, teamId, id] : [`U${n}`, `u${n}@conc.local`, role, teamId],
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

async function newLead(seller: ServiceContext): Promise<string> {
  const phone = `5579${String(900000000 + ++seq).slice(0, 9)}`;
  const lead = await createLead(seller, { name: `Lead ${seq}`, phone, interestCourseId: COURSE });
  return lead.id;
}

async function addSession(userId: string): Promise<void> {
  await monitor.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [`s${++seq}`, userId]);
}

type Outcome = { ok: true } | { ok: false; error: unknown };
type Tracked = { promise: Promise<Outcome>; settled: () => boolean };

function track(promise: Promise<unknown>): Tracked {
  let done = false;
  const settledPromise = promise.then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  settledPromise.finally(() => (done = true));
  return { promise: settledPromise, settled: () => done };
}

function sqlState(error: unknown): string | undefined {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** Nome do erro de domínio, ou SQLSTATE do banco. */
function describe_(outcome: Outcome): string {
  if (outcome.ok) return "ok";
  return outcome.error instanceof AppError ? outcome.error.name : `SQLSTATE ${sqlState(outcome.error) ?? "?"}`;
}

/** Sessão "portão": abre transação e segura a trava pedida até `release`. */
async function gate(lockSql: string, params: unknown[] = []): Promise<{ pid: number; release: () => Promise<void> }> {
  const c = await db.client("crm-test-gate");
  const { rows } = await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  await c.query("BEGIN");
  await c.query(lockSql, params);
  return {
    pid: rows[0].pid,
    release: async () => {
      await c.query("ROLLBACK");
      await c.end();
    },
  };
}

const blockedBy = async (pid: number) => (await lockWaiters(monitor)).some((w) => w.blockedBy.includes(pid));
const waiting = async (n: number) => (await lockWaiters(monitor)).length >= n;

async function eventTypes(leadId: string): Promise<string[]> {
  const { rows } = await monitor.query<{ type: string }>(`SELECT type FROM lead_events WHERE lead_id = $1 ORDER BY id`, [leadId]);
  return rows.map((r) => r.type);
}

async function leadRow(leadId: string) {
  const { rows } = await monitor.query(`SELECT name, owner_id, team_id, stage, status FROM leads WHERE id = $1`, [leadId]);
  return rows[0] as { name: string; owner_id: string | null; team_id: string; stage: string; status: string };
}

/** Organização nova por cenário: equipe A (supervisor + vendedor dono do lead) e ADMIN. */
async function scenario() {
  const admin = await insertUser("ADMIN");
  const supA = await insertUser("SUPERVISOR");
  const teamA = await insertTeam(supA);
  const seller = await insertUser("SELLER", teamA);
  const sellerCtx = await ctx(seller);
  const leadId = await newLead(sellerCtx);
  return { admin, supA, teamA, seller, sellerCtx, leadId };
}

// ---------------------------------------------------------------------------

describe.skipIf(!REAL_PG_URL)("concorrência real: mutações de lead × vendedor (P11)", () => {
  it("controle: a ordem antiga lead → vendedor contra vendedor → lead produz deadlock (40P01)", async () => {
    const { seller, leadId } = await scenario();
    const a = await db.client("crm-test-a");
    const b = await db.client("crm-test-b");
    try {
      await a.query("BEGIN");
      await a.query(`SELECT 1 FROM leads WHERE id = $1 FOR UPDATE`, [leadId]);
      await b.query("BEGIN");
      await b.query(`UPDATE users SET active = false WHERE id = $1`, [seller]);
      const bLeads = track(
        b.query(`UPDATE leads SET owner_id = NULL, unassigned_at = now(), unassigned_reason = 'OWNER_DEACTIVATED'
                  WHERE owner_id = $1 AND status = 'ACTIVE' AND stage <> 'CLOSED'`, [seller]),
      );
      await waitUntil(() => waiting(1), "B bloqueada pelo lead");
      const aUpdate = track(a.query(`UPDATE leads SET stage = 'NO_ANSWER' WHERE id = $1`, [leadId]));
      const results = [await aUpdate.promise, await bLeads.promise].map((o) => (o.ok ? "ok" : sqlState((o as { error: unknown }).error)));
      expect(results.sort()).toEqual(["40P01", "ok"]);
    } finally {
      await a.query("ROLLBACK").catch(() => {});
      await b.query("ROLLBACK").catch(() => {});
      await a.end();
      await b.end();
    }
  });

  it("P11: mover etapa × desativação do vendedor (desativação primeiro) — sem deadlock; vendedor inativo é recusado", async () => {
    const { admin, seller, sellerCtx, leadId } = await scenario();
    await addSession(seller);
    // Para a desativação DEPOIS de alterar users e ANTES de mexer nos leads.
    const g = await gate(`SELECT 1 FROM sessions WHERE user_id = $1 FOR UPDATE`, [seller]);
    const deactivate = track(setUserActive(await ctx(admin), seller, false));
    await waitUntil(() => blockedBy(g.pid), "desativação parada no portão");
    const move = track(moveLeadStage(sellerCtx, leadId, { toStage: "NO_ANSWER" }));
    await waitUntil(() => waiting(2), "movimentação esperando o vendedor");
    await g.release();

    expect([describe_(await deactivate.promise), describe_(await move.promise)]).toEqual(["ok", "UnauthenticatedError"]);
    expect(await leadRow(leadId)).toMatchObject({ owner_id: null, stage: "NEW", status: "ACTIVE" });
    expect(await eventTypes(leadId)).toEqual(["CREATED", "UNASSIGNED"]);
  });

  it("P11: mover etapa × desativação (movimentação primeiro) — as duas concluem, em fila", async () => {
    const { admin, teamA, seller, sellerCtx, leadId } = await scenario();
    // Para a movimentação ao gravar o evento (FK de lead_events.team_id), já com as travas tomadas.
    const g = await gate(`SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, [teamA]);
    const move = track(moveLeadStage(sellerCtx, leadId, { toStage: "NO_ANSWER" }));
    await waitUntil(() => blockedBy(g.pid), "movimentação parada no portão");
    const deactivate = track(setUserActive(await ctx(admin), seller, false));
    await waitUntil(() => waiting(2), "desativação esperando a movimentação");
    await g.release();

    expect([describe_(await move.promise), describe_(await deactivate.promise)]).toEqual(["ok", "ok"]);
    expect(await leadRow(leadId)).toMatchObject({ owner_id: null, stage: "NO_ANSWER" });
    expect(await eventTypes(leadId)).toEqual(["CREATED", "STAGE_CHANGED", "UNASSIGNED"]);
  });

  it("P11: edição pelo supervisor × desativação (desativação primeiro) — refaz com o lead já na fila", async () => {
    const { admin, supA, seller, leadId } = await scenario();
    await addSession(seller);
    const g = await gate(`SELECT 1 FROM sessions WHERE user_id = $1 FOR UPDATE`, [seller]);
    const deactivate = track(setUserActive(await ctx(admin), seller, false));
    await waitUntil(() => blockedBy(g.pid), "desativação parada no portão");
    const edit = track(editLead(await ctx(supA), leadId, { name: "Nome Editado" }));
    await waitUntil(() => waiting(2), "edição esperando o vendedor");
    await g.release();

    expect([describe_(await deactivate.promise), describe_(await edit.promise)]).toEqual(["ok", "ok"]);
    expect(await leadRow(leadId)).toMatchObject({ name: "Nome Editado", owner_id: null });
    expect(await eventTypes(leadId)).toEqual(["CREATED", "UNASSIGNED", "DETAILS_UPDATED"]);
  });

  it("mover etapa × troca de equipe do vendedor (troca primeiro) — o evento usa a equipe nova", async () => {
    const { admin, seller, sellerCtx, leadId } = await scenario();
    const supB = await insertUser("SUPERVISOR");
    const teamB = await insertTeam(supB);
    // Para a troca DEPOIS de alterar users (FK users.team_id → teams) e ANTES de mover os leads.
    const g = await gate(`SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, [teamB]);
    const change = track(changeSellerTeam(await ctx(admin), seller, { teamId: teamB }));
    await waitUntil(() => blockedBy(g.pid), "troca de equipe parada no portão");
    const move = track(moveLeadStage(sellerCtx, leadId, { toStage: "NO_ANSWER" }));
    await waitUntil(() => waiting(2), "movimentação esperando o vendedor");
    await g.release();

    expect([describe_(await change.promise), describe_(await move.promise)]).toEqual(["ok", "ok"]);
    expect(await leadRow(leadId)).toMatchObject({ owner_id: seller, team_id: teamB, stage: "NO_ANSWER" });
    expect(await eventTypes(leadId)).toEqual(["CREATED", "TEAM_CHANGED", "STAGE_CHANGED"]);
    const { rows } = await monitor.query(`SELECT team_id, supervisor_id FROM lead_events WHERE lead_id = $1 AND type = 'STAGE_CHANGED'`, [
      leadId,
    ]);
    expect(rows).toEqual([{ team_id: teamB, supervisor_id: supB }]);
  });

  it("troca concorrente de responsável: o dono muda entre a leitura e as travas → a transação é refeita", async () => {
    const { admin, supA, teamA, seller, leadId } = await scenario();
    const s2 = await insertUser("SELLER", teamA);
    // X ordena antes de todos os envolvidos: a transferência para X espera nele sem travar mais nada.
    const x = await insertUser("SELLER", teamA, `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`);
    const g = await gate(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [x]);
    const toX = track(transferLead(await ctx(supA), leadId, { toSellerId: x }));
    await waitUntil(() => blockedBy(g.pid), "transferência para X parada no portão");
    const toS2 = track(transferLead(await ctx(admin), leadId, { toSellerId: s2 }));
    await waitUntil(async () => toS2.settled() || (await waiting(2)), "transferência para S2 concluída ou bloqueada");
    await g.release();

    expect([describe_(await toS2.promise), describe_(await toX.promise)]).toEqual(["ok", "ok"]);
    expect((await leadRow(leadId)).owner_id).toBe(x);
    const { rows } = await monitor.query(
      `SELECT from_owner_id, owner_id FROM lead_events WHERE lead_id = $1 AND type = 'TRANSFERRED' ORDER BY id`,
      [leadId],
    );
    expect(rows).toEqual([
      { from_owner_id: seller, owner_id: s2 },
      { from_owner_id: s2, owner_id: x },
    ]);
  });

  it("redistribuição × desativação do vendedor de destino (desativação primeiro) — recusa com mensagem de negócio", async () => {
    const { admin, supA, teamA, seller, leadId } = await scenario();
    await monitor.query(
      `UPDATE leads SET stage = 'FOLLOW_UP_3', stage_entered_at = now() - interval '48 hours', stage_due_at = now() - interval '1 hour' WHERE id = $1`,
      [leadId],
    );
    const x = await insertUser("SELLER", teamA);
    await addSession(x);
    const g = await gate(`SELECT 1 FROM sessions WHERE user_id = $1 FOR UPDATE`, [x]);
    const deactivate = track(setUserActive(await ctx(admin), x, false));
    await waitUntil(() => blockedBy(g.pid), "desativação de X parada no portão");
    const redistribute = track(redistributeLead(await ctx(supA), leadId, { toSellerId: x }));
    await waitUntil(() => waiting(2), "redistribuição esperando X");
    await g.release();

    expect([describe_(await deactivate.promise), describe_(await redistribute.promise)]).toEqual(["ok", "ValidationError"]);
    expect(await leadRow(leadId)).toMatchObject({ owner_id: seller, stage: "FOLLOW_UP_3" });
    expect(await eventTypes(leadId)).toEqual(["CREATED"]);
  });

  it("recuperação da Lixeira × desativação do vendedor de destino (recuperação primeiro) — o lead volta para a fila", async () => {
    const { admin, supA, teamA, leadId } = await scenario();
    await trashLead(await ctx(supA), leadId);
    const x = await insertUser("SELLER", teamA);
    // Para a recuperação ao abrir o ciclo novo (FK lead_cycles.team_id), já com as travas tomadas.
    const g = await gate(`SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, [teamA]);
    const restore = track(restoreLead(await ctx(supA), leadId, { toSellerId: x }));
    await waitUntil(() => blockedBy(g.pid), "recuperação parada no portão");
    const deactivate = track(setUserActive(await ctx(admin), x, false));
    await waitUntil(async () => deactivate.settled() || (await waiting(2)), "desativação concluída ou esperando");
    await g.release();

    expect([describe_(await restore.promise), describe_(await deactivate.promise)]).toEqual(["ok", "ok"]);
    expect(await leadRow(leadId)).toMatchObject({ owner_id: null, stage: "REWORK", status: "ACTIVE" });
    expect(await eventTypes(leadId)).toEqual(["CREATED", "TRASHED", "RESTORED", "UNASSIGNED"]);
  });
});

describe.skipIf(!REAL_PG_URL)("concorrência real: runTransaction", () => {
  it("deadlock real (40P01): a vítima é refeita e cada operação grava uma única auditoria", async () => {
    const u1 = await insertUser("ADMIN");
    const u2 = await insertUser("ADMIN");
    const tag = `deadlock-${++seq}`;
    let aLocked!: () => void;
    let bLocked!: () => void;
    const aReady = new Promise<void>((r) => (aLocked = r));
    const bReady = new Promise<void>((r) => (bLocked = r));
    const attempts = { a: 0, b: 0 };

    const op = (name: "a" | "b", first: string, second: string, signal: () => void, other: Promise<void>) =>
      runTransaction(db.handle.db, async (tx) => {
        attempts[name]++;
        await tx.execute(sql`SELECT 1 FROM users WHERE id = ${first} FOR UPDATE`);
        if (attempts[name] === 1) {
          signal();
          await other;
        }
        await tx.execute(sql`SELECT 1 FROM users WHERE id = ${second} FOR UPDATE`);
        await recordAudit(tx, { actorId: u1, action: "user.updated", entityType: "user", entityId: `${tag}-${name}` });
      });

    const results = await Promise.allSettled([op("a", u1, u2, aLocked, bReady), op("b", u2, u1, bLocked, aReady)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(attempts.a + attempts.b).toBe(3);
    const { rows } = await monitor.query(`SELECT entity_id FROM audit_events WHERE entity_id LIKE $1 ORDER BY entity_id`, [`${tag}-%`]);
    expect(rows.map((r) => r.entity_id)).toEqual([`${tag}-a`, `${tag}-b`]);
  });

  it("falha de serialização (40001) do servidor é refeita; nada da tentativa desfeita sobrevive", async () => {
    const actor = await insertUser("ADMIN");
    const tag = `ser-${++seq}`;
    let attempts = 0;
    await runTransaction(db.handle.db, async (tx) => {
      attempts++;
      await recordAudit(tx, { actorId: actor, action: "user.updated", entityType: "user", entityId: `${tag}-${attempts}` });
      if (attempts === 1) await tx.execute(sql.raw(`DO $$ BEGIN RAISE EXCEPTION 'simulada' USING ERRCODE = '40001'; END $$`));
    });
    expect(attempts).toBe(2);
    const { rows } = await monitor.query(`SELECT entity_id FROM audit_events WHERE entity_id LIKE $1`, [`${tag}-%`]);
    expect(rows.map((r) => r.entity_id)).toEqual([`${tag}-2`]);
  });

  it("usa READ COMMITTED mesmo quando o padrão do banco é outro", async () => {
    await monitor.query(`ALTER DATABASE ${db.name} SET default_transaction_isolation = 'serializable'`);
    const fresh = connectDatabase(db.url);
    try {
      const level = async (tx: typeof fresh.db) =>
        ((await tx.execute(sql`SELECT current_setting('transaction_isolation') AS level`)) as unknown as { rows: { level: string }[] })
          .rows[0].level;
      expect(await fresh.db.transaction((tx) => level(tx))).toBe("serializable");
      expect(await runTransaction(fresh.db, (tx) => level(tx))).toBe("read committed");
    } finally {
      await fresh.close();
      await monitor.query(`ALTER DATABASE ${db.name} RESET default_transaction_isolation`);
    }
  });
});
