import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadActor } from "@/server/auth/session";
import type { ServiceContext } from "@/server/context";
import { createLead, moveLeadStage, transferLead } from "@/server/modules/leads/leads.service";
import { setTeamSupervisor, updateTeam } from "@/server/modules/teams/teams.service";
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
 * Concorrência REAL (PostgreSQL local, CRM_TEST_PG_URL) entre equipes,
 * vendedores, supervisores e eventos de lead.
 *
 * Cada cenário força um interleaving com uma sessão "portão" que segura uma
 * trava escolhida; o avanço é detectado por pg_stat_activity/pg_blocking_pids.
 * Além do resultado de cada operação, os testes conferem INVARIANTES do estado
 * final (equipe inativa sem vendedor ativo nem lead em operação; nenhuma
 * equipe liderada por supervisor inativo).
 */

let db: RealPgDatabase;
let monitor: Client;
let seq = 0;
const COURSE = "c0000000-0000-4000-8000-000000000002";

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

// ---------------------------------------------------------------------------

async function insertUser(role: "ADMIN" | "SUPERVISOR" | "SELLER", teamId: string | null = null): Promise<string> {
  const n = ++seq;
  const { rows } = await monitor.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, team_id) VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
    [`U${n}`, `t${n}@conc.local`, role, teamId],
  );
  return rows[0].id;
}

async function insertTeam(supervisorId: string | null): Promise<string> {
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

async function newLead(sellerId: string): Promise<string> {
  const phone = `5579${String(910000000 + ++seq).slice(0, 9)}`;
  return (await createLead(await ctx(sellerId), { name: `Lead ${seq}`, phone, interestCourseId: COURSE })).id;
}

const waiting = async (n: number) => (await lockWaiters(monitor)).length >= n;
const blockedBy = async (pid: number) => (await lockWaiters(monitor)).some((w) => w.blockedBy.includes(pid));

/** Violações dos invariantes nas equipes do cenário (deve ser sempre vazio). */
async function violations(teamIds: string[]): Promise<string[]> {
  const { rows } = await monitor.query<{ v: string }>(`
    SELECT 'equipe inativa com vendedor ativo: ' || t.id AS v
      FROM teams t JOIN users u ON u.team_id = t.id
     WHERE NOT t.active AND u.active AND t.id = ANY($1::uuid[])
    UNION ALL
    SELECT 'equipe inativa com lead em operação: ' || t.id
      FROM teams t JOIN leads l ON l.team_id = t.id
     WHERE NOT t.active AND l.status = 'ACTIVE' AND l.stage <> 'CLOSED' AND t.id = ANY($1::uuid[])
    UNION ALL
    SELECT 'equipe liderada por supervisor inativo: ' || t.id
      FROM teams t JOIN users u ON u.id = t.supervisor_id
     WHERE NOT u.active AND t.id = ANY($1::uuid[])`, [teamIds]);
  return rows.map((r) => r.v);
}

async function value<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await monitor.query(sql, params);
  return Object.values(rows[0] as Record<string, T>)[0];
}

// ---------------------------------------------------------------------------

describe.skipIf(!REAL_PG_URL)("concorrência real: desativação de equipe", () => {
  it("× troca de equipe do vendedor (desativação primeiro): a troca é recusada; nenhum vendedor ativo em equipe inativa", async () => {
    const supT = await insertUser("SUPERVISOR");
    const teamT = await insertTeam(supT);
    const supU = await insertUser("SUPERVISOR");
    const teamU = await insertTeam(supU);
    const seller = await insertUser("SELLER", teamU);
    const leadId = await newLead(seller);
    const adminA = await insertUser("ADMIN");
    const adminB = await insertUser("ADMIN");
    const ctxA = await ctx(adminA);
    const ctxB = await ctx(adminB);

    // Para a desativação ao gravar a auditoria (FK actor_id), depois de alterar a equipe.
    const g = await gate(db, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [adminA]);
    const deactivate = track(updateTeam(ctxA, teamT, { active: false }));
    await waitUntil(() => blockedBy(g.pid), "desativação parada no portão");
    const move = track(changeSellerTeam(ctxB, seller, { teamId: teamT }));
    await waitUntil(async () => move.settled() || (await waiting(2)), "troca concluída ou esperando");
    await g.release();

    const outcomes = [outcomeName(await deactivate.promise), outcomeName(await move.promise)];
    expect(await violations([teamT, teamU])).toEqual([]);
    expect(outcomes).toEqual(["ok", "ValidationError"]);
    expect(await value(`SELECT team_id FROM users WHERE id = $1`, [seller])).toBe(teamU);
    expect(await value(`SELECT team_id FROM leads WHERE id = $1`, [leadId])).toBe(teamU);
  });

  it("× troca de equipe do vendedor (troca primeiro): a desativação vê o vendedor e é recusada", async () => {
    const supT = await insertUser("SUPERVISOR");
    const teamT = await insertTeam(supT);
    const supU = await insertUser("SUPERVISOR");
    const teamU = await insertTeam(supU);
    const seller = await insertUser("SELLER", teamU);
    const leadId = await newLead(seller);
    const ctxA = await ctx(await insertUser("ADMIN"));
    const ctxB = await ctx(await insertUser("ADMIN"));

    // Para a troca ao mover os leads do vendedor, já com users alterado.
    const g = await gate(db, `SELECT 1 FROM leads WHERE id = $1 FOR UPDATE`, [leadId]);
    const move = track(changeSellerTeam(ctxB, seller, { teamId: teamT }));
    await waitUntil(() => blockedBy(g.pid), "troca parada no portão");
    const deactivate = track(updateTeam(ctxA, teamT, { active: false }));
    await waitUntil(async () => deactivate.settled() || (await waiting(2)), "desativação concluída ou esperando");
    await g.release();

    const outcomes = [outcomeName(await move.promise), outcomeName(await deactivate.promise)];
    expect(await violations([teamT, teamU])).toEqual([]);
    expect(outcomes).toEqual(["ok", "ConflictError"]);
    expect(await value(`SELECT active FROM teams WHERE id = $1`, [teamT])).toBe(true);
    expect(await value(`SELECT team_id FROM leads WHERE id = $1`, [leadId])).toBe(teamT);
  });

  it("× transferência de lead para vendedor da equipe (transferência primeiro): invariante preservado", async () => {
    const supT = await insertUser("SUPERVISOR");
    const teamT = await insertTeam(supT);
    const x = await insertUser("SELLER", teamT);
    const supU = await insertUser("SUPERVISOR");
    const teamU = await insertTeam(supU);
    const s1 = await insertUser("SELLER", teamU);
    const leadId = await newLead(s1);
    const ctxA = await ctx(await insertUser("ADMIN"));
    const ctxB = await ctx(await insertUser("ADMIN"));

    // Para a transferência ao gravar o evento (FK do ciclo), com as travas tomadas.
    const g = await gate(db, `SELECT 1 FROM lead_cycles WHERE lead_id = $1 AND ended_at IS NULL FOR UPDATE`, [leadId]);
    const transfer = track(transferLead(ctxB, leadId, { toSellerId: x }));
    await waitUntil(() => blockedBy(g.pid), "transferência parada no portão");
    const deactivate = track(updateTeam(ctxA, teamT, { active: false }));
    await waitUntil(async () => deactivate.settled() || (await waiting(2)), "desativação concluída ou esperando");
    await g.release();

    const outcomes = [outcomeName(await transfer.promise), outcomeName(await deactivate.promise)];
    expect(await violations([teamT, teamU])).toEqual([]);
    expect(outcomes).toEqual(["ok", "ConflictError"]);
    expect(await value(`SELECT team_id FROM leads WHERE id = $1`, [leadId])).toBe(teamT);
  });
});

describe.skipIf(!REAL_PG_URL)("concorrência real: equipe inativa × reativação de vendedor", () => {
  async function inactiveSellerScenario() {
    const supT = await insertUser("SUPERVISOR");
    const teamT = await insertTeam(supT);
    const seller = await insertUser("SELLER", teamT);
    await monitor.query(`UPDATE users SET active = false WHERE id = $1`, [seller]);
    const adminA = await insertUser("ADMIN");
    const adminB = await insertUser("ADMIN");
    return { teamT, seller, adminA, adminB, ctxA: await ctx(adminA), ctxB: await ctx(adminB) };
  }

  it("desativação da equipe primeiro: a reativação espera, vê a equipe inativa e é recusada", async () => {
    const { teamT, seller, adminA, ctxA, ctxB } = await inactiveSellerScenario();
    // Para a desativação ao gravar a auditoria, com a equipe já alterada.
    const g = await gate(db, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [adminA]);
    const deactivate = track(updateTeam(ctxA, teamT, { active: false }));
    await waitUntil(() => blockedBy(g.pid), "desativação parada no portão");
    const reactivate = track(setUserActive(ctxB, seller, true));
    await waitUntil(async () => reactivate.settled() || (await waiting(2)), "reativação concluída ou esperando");
    await g.release();

    const outcomes = [outcomeName(await deactivate.promise), outcomeName(await reactivate.promise)];
    expect(await violations([teamT])).toEqual([]);
    expect(outcomes).toEqual(["ok", "ValidationError"]);
    expect(await value(`SELECT active FROM users WHERE id = $1`, [seller])).toBe(false);
  });

  it("reativação primeiro: a desativação espera, vê o vendedor ativo e é recusada", async () => {
    const { teamT, seller, adminB, ctxA, ctxB } = await inactiveSellerScenario();
    // Para a reativação ao gravar a auditoria, já com o vendedor ativo e a equipe travada.
    const g = await gate(db, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [adminB]);
    const reactivate = track(setUserActive(ctxB, seller, true));
    await waitUntil(() => blockedBy(g.pid), "reativação parada no portão");
    const deactivate = track(updateTeam(ctxA, teamT, { active: false }));
    await waitUntil(async () => deactivate.settled() || (await waiting(2)), "desativação concluída ou esperando");
    await g.release();

    const outcomes = [outcomeName(await reactivate.promise), outcomeName(await deactivate.promise)];
    expect(await violations([teamT])).toEqual([]);
    expect(outcomes).toEqual(["ok", "ConflictError"]);
    expect(await value(`SELECT active FROM teams WHERE id = $1`, [teamT])).toBe(true);
  });
});

describe.skipIf(!REAL_PG_URL)("concorrência real: supervisor da equipe", () => {
  it("troca de supervisor × desativação do novo supervisor (troca primeiro): a desativação vê a equipe e é recusada", async () => {
    const supOld = await insertUser("SUPERVISOR");
    const teamT = await insertTeam(supOld);
    const y = await insertUser("SUPERVISOR");
    const ctxA = await ctx(await insertUser("ADMIN"));
    const ctxB = await ctx(await insertUser("ADMIN"));

    // Para a troca ao alterar a equipe (UPDATE teams espera o FOR SHARE do portão).
    const g = await gate(db, `SELECT 1 FROM teams WHERE id = $1 FOR SHARE`, [teamT]);
    const assign = track(setTeamSupervisor(ctxB, teamT, { supervisorId: y }));
    await waitUntil(() => blockedBy(g.pid), "troca de supervisor parada no portão");
    const deactivate = track(setUserActive(ctxA, y, false));
    await waitUntil(async () => deactivate.settled() || (await waiting(2)), "desativação concluída ou esperando");
    await g.release();

    const outcomes = [outcomeName(await assign.promise), outcomeName(await deactivate.promise)];
    expect(await violations([teamT])).toEqual([]);
    expect(outcomes).toEqual(["ok", "ConflictError"]);
    expect(await value(`SELECT supervisor_id FROM teams WHERE id = $1`, [teamT])).toBe(y);
    expect(await value(`SELECT active FROM users WHERE id = $1`, [y])).toBe(true);
  });

  it("desativação do supervisor × troca de supervisor para ele (desativação primeiro): a troca é recusada", async () => {
    const supOld = await insertUser("SUPERVISOR");
    const teamT = await insertTeam(supOld);
    const y = await insertUser("SUPERVISOR");
    await monitor.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [`s${++seq}`, y]);
    const ctxA = await ctx(await insertUser("ADMIN"));
    const ctxB = await ctx(await insertUser("ADMIN"));

    // Para a desativação ao encerrar as sessões, já com users alterado.
    const g = await gate(db, `SELECT 1 FROM sessions WHERE user_id = $1 FOR UPDATE`, [y]);
    const deactivate = track(setUserActive(ctxA, y, false));
    await waitUntil(() => blockedBy(g.pid), "desativação parada no portão");
    const assign = track(setTeamSupervisor(ctxB, teamT, { supervisorId: y }));
    await waitUntil(async () => assign.settled() || (await waiting(2)), "troca concluída ou esperando");
    await g.release();

    const outcomes = [outcomeName(await deactivate.promise), outcomeName(await assign.promise)];
    expect(await violations([teamT])).toEqual([]);
    expect(outcomes).toEqual(["ok", "ValidationError"]);
    expect(await value(`SELECT supervisor_id FROM teams WHERE id = $1`, [teamT])).toBe(supOld);
  });

  it("evento de lead × troca de supervisor: o supervisor gravado é o vigente até o COMMIT do evento", async () => {
    const supX = await insertUser("SUPERVISOR");
    const teamT = await insertTeam(supX);
    const seller = await insertUser("SELLER", teamT);
    const leadId = await newLead(seller);
    const y = await insertUser("SUPERVISOR");
    const ctxAdmin = await ctx(await insertUser("ADMIN"));
    const ctxSeller = await ctx(seller);

    // Para a movimentação ao gravar o evento (FK do ciclo): o supervisor já foi lido.
    const g = await gate(db, `SELECT 1 FROM lead_cycles WHERE lead_id = $1 AND ended_at IS NULL FOR UPDATE`, [leadId]);
    const move = track(moveLeadStage(ctxSeller, leadId, { toStage: "NO_ANSWER" }));
    await waitUntil(() => blockedBy(g.pid), "movimentação parada no portão");
    const assign = track(setTeamSupervisor(ctxAdmin, teamT, { supervisorId: y }));
    await waitUntil(async () => assign.settled() || (await waiting(2)), "troca de supervisor concluída ou esperando");
    // A troca NÃO pode terminar enquanto o evento (que já leu X) não foi gravado.
    const assignFinishedBeforeEvent = assign.settled();
    await g.release();

    expect([outcomeName(await move.promise), outcomeName(await assign.promise)]).toEqual(["ok", "ok"]);
    expect(assignFinishedBeforeEvent).toBe(false);
    expect(await value(`SELECT supervisor_id FROM lead_events WHERE lead_id = $1 AND type = 'STAGE_CHANGED'`, [leadId])).toBe(supX);
    expect(await value(`SELECT supervisor_id FROM teams WHERE id = $1`, [teamT])).toBe(y);
  });
});
