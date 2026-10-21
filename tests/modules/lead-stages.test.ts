import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAGE_TRANSITIONS, STAGES_WITH_DEADLINE } from "@/lib/leads";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { DatabaseHandle } from "@/server/db/connect";
import { LEAD_STAGES, leadCycles, leadEvents, leads, type LeadStage } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import {
  addLeadNote,
  AWAITING_SUPERVISOR_MESSAGE,
  createLead,
  editLead,
  getLead,
  getLeadTimeline,
  getNegotiationBlock,
  listLeads,
  moveLeadStage,
  NegotiationOverdueError,
} from "@/server/modules/leads/leads.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourse, setLeadStage } from "../support/leads";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let courseId: string;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  courseId = await insertCourse(handle);
});
afterAll(() => handle.close());

let phoneSeq = 0;
async function newLead(sellerId: string, name = "Lead Kanban") {
  return (await createLead(await org.ctx(sellerId), { name, phone: `(79) 9${String(++phoneSeq).padStart(8, "0")}`, interestCourseId: courseId })).id;
}

/** Coloca o lead na etapa, com prazo futuro quando a etapa tem prazo. */
async function putIn(leadId: string, stage: LeadStage) {
  await setLeadStage(handle, leadId, stage, STAGES_WITH_DEADLINE.includes(stage) ? 5 : undefined);
}

const rowOf = async (id: string) => (await handle.db.select().from(leads).where(eq(leads.id, id)))[0];
const lastEvent = async (id: string) =>
  (await handle.db.select().from(leadEvents).where(eq(leadEvents.leadId, id)).orderBy(asc(leadEvents.id))).at(-1)!;
const hoursFromNow = (date: Date | null) => (date ? (date.getTime() - Date.now()) / 3_600_000 : null);

const VALID = (Object.entries(STAGE_TRANSITIONS) as [LeadStage, readonly LeadStage[]][]).flatMap(([from, tos]) => tos.map((to) => [from, to] as const));

describe("transições válidas (vendedor responsável)", () => {
  it.each(VALID)("%s → %s: muda a etapa, reinicia a entrada e define o prazo da nova etapa", async (from, to) => {
    const id = await newLead(org.ids.sellerA1);
    await putIn(id, from);
    const seller = await org.ctx(org.ids.sellerA1);

    const moved = await moveLeadStage(seller, id, { toStage: to });
    expect(moved.stage).toBe(to);

    const row = await rowOf(id);
    expect(Math.abs(hoursFromNow(row.stageEnteredAt)!)).toBeLessThan(0.05);
    if (STAGES_WITH_DEADLINE.includes(to)) {
      const expected = to === "NEGOTIATION" ? BUSINESS_RULES.negotiationDeadlineHours : BUSINESS_RULES.followUpDeadlineHours;
      expect(hoursFromNow(row.stageDueAt)).toBeCloseTo(expected, 1);
    } else {
      expect(row.stageDueAt).toBeNull();
    }
  });

  it("o mapa cobre exatamente o fluxo combinado", () => {
    expect(STAGE_TRANSITIONS).toEqual({
      NEW: ["NO_ANSWER", "NEGOTIATION"],
      NO_ANSWER: ["FOLLOW_UP_1", "NEGOTIATION"],
      FOLLOW_UP_1: ["FOLLOW_UP_2", "NEGOTIATION"],
      FOLLOW_UP_2: ["FOLLOW_UP_3", "NEGOTIATION"],
      FOLLOW_UP_3: ["NEGOTIATION"],
      NEGOTIATION: ["FOLLOW_UP_1"],
      REWORK: ["FOLLOW_UP_1"],
      CLOSED: [],
    });
  });
});

describe("transições inválidas são recusadas no backend", () => {
  const FROM: LeadStage[] = LEAD_STAGES.filter((s) => s !== "CLOSED");
  it.each(FROM)("a partir de %s, todo destino fora do mapa é recusado e nada muda", async (from) => {
    const id = await newLead(org.ids.sellerA1);
    await putIn(id, from);
    const before = await rowOf(id);
    const seller = await org.ctx(org.ids.sellerA1);
    const invalid = LEAD_STAGES.filter((to) => !STAGE_TRANSITIONS[from].includes(to));
    expect(invalid.length).toBeGreaterThan(0);
    for (const to of invalid) {
      await expect(moveLeadStage(seller, id, { toStage: to }), `${from} → ${to}`).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await rowOf(id)).toEqual(before);
  });

  it("mensagens claras para Fechamento, Retrabalho e volta de etapa", async () => {
    const id = await newLead(org.ids.sellerA1);
    await putIn(id, "FOLLOW_UP_3");
    const seller = await org.ctx(org.ids.sellerA1);
    const message = (to: LeadStage) => moveLeadStage(seller, id, { toStage: to }).catch((e: Error) => e.message);
    expect(await message("CLOSED")).toBe("Fechamento só acontece ao registrar uma venda.");
    expect(await message("REWORK")).toBe("Retrabalho só acontece por redistribuição ou recuperação da Lixeira, feitas pelo supervisor.");
    expect(await message("FOLLOW_UP_2")).toBe("Movimentação não permitida: de Follow-up 3 para Follow-up 2.");
    expect(await message("FOLLOW_UP_3")).toBe("O lead já está em Follow-up 3.");
    await expect(moveLeadStage(seller, id, { toStage: "QUALQUER" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("quem pode movimentar", () => {
  it("vendedor não movimenta lead de outro vendedor (404) e supervisor/admin não movimentam (permissão)", async () => {
    const ofA2 = await newLead(org.ids.sellerA2);
    await expect(moveLeadStage(await org.ctx(org.ids.sellerA1), ofA2, { toStage: "NO_ANSWER" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(moveLeadStage(await org.ctx(org.ids.sellerB1), ofA2, { toStage: "NO_ANSWER" })).rejects.toBeInstanceOf(NotFoundError);
    for (const userId of [org.ids.supA, org.ids.supB, org.ids.admin]) {
      await expect(moveLeadStage(await org.ctx(userId), ofA2, { toStage: "NO_ANSWER" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await rowOf(ofA2)).stage).toBe("NEW");
  });

  it("campos extras são recusados (não dá para forçar prazo ou responsável)", async () => {
    const id = await newLead(org.ids.sellerA1);
    const seller = await org.ctx(org.ids.sellerA1);
    await expect(moveLeadStage(seller, id, { toStage: "NO_ANSWER", stageDueAt: new Date() })).rejects.toBeInstanceOf(ValidationError);
    await expect(editLead(seller, id, { stage: "NEGOTIATION" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("Follow-up 3", () => {
  it("não vencido: pode ir para Negociação", async () => {
    const id = await newLead(org.ids.sellerA1);
    await setLeadStage(handle, id, "FOLLOW_UP_3", 2);
    await expect(moveLeadStage(await org.ctx(org.ids.sellerA1), id, { toStage: "NEGOTIATION" })).resolves.toMatchObject({ stage: "NEGOTIATION" });
  });

  it("vencido: somente leitura para o vendedor; supervisor ainda edita", async () => {
    const id = await newLead(org.ids.sellerA1, "Aguardando");
    await setLeadStage(handle, id, "FOLLOW_UP_3", -1);
    const before = await rowOf(id);
    const seller = await org.ctx(org.ids.sellerA1);

    for (const attempt of [
      moveLeadStage(seller, id, { toStage: "NEGOTIATION" }),
      editLead(seller, id, { name: "Outro Nome" }),
      addLeadNote(seller, id, { body: "Tentando sair da fila" }),
    ]) {
      const error = await attempt.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as Error).message).toBe(AWAITING_SUPERVISOR_MESSAGE);
    }
    expect(await rowOf(id)).toEqual(before);

    // Continua visível, com histórico, para o vendedor.
    await expect(getLead(seller, id)).resolves.toMatchObject({ queueReason: "FOLLOW_UP_3_EXPIRED" });
    await expect(getLeadTimeline(seller, id)).resolves.toHaveLength(1);
    await expect(editLead(await org.ctx(org.ids.supA), id, { name: "Corrigido pelo Supervisor" })).resolves.toMatchObject({
      name: "Corrigido pelo Supervisor",
    });
  });
});

describe("prazos", () => {
  it("sair de etapa com prazo para etapa sem prazo limpa o prazo; observação na negociação não muda a entrada", async () => {
    const id = await newLead(org.ids.sellerA1);
    const seller = await org.ctx(org.ids.sellerA1);
    await moveLeadStage(seller, id, { toStage: "NEGOTIATION" });
    const negotiating = await rowOf(id);
    expect(hoursFromNow(negotiating.stageDueAt)).toBeCloseTo(24, 1);

    await setLeadStage(handle, id, "NEGOTIATION", 1); // entrou há 48 h, vence em 1 h
    const entered = (await rowOf(id)).stageEnteredAt;
    await addLeadNote(seller, id, { body: "Retorno amanhã cedo." });
    const renewed = await rowOf(id);
    expect(renewed.stageEnteredAt).toEqual(entered);
    expect(hoursFromNow(renewed.stageDueAt)).toBeCloseTo(24, 1);

    await moveLeadStage(seller, id, { toStage: "FOLLOW_UP_1" });
    expect(hoursFromNow((await rowOf(id)).stageDueAt)).toBeCloseTo(24, 1);

    const other = await newLead(org.ids.sellerA1);
    await moveLeadStage(seller, other, { toStage: "NO_ANSWER" });
    expect((await rowOf(other)).stageDueAt).toBeNull();
  });
});

describe("negociação vencida bloqueia o vendedor", () => {
  let seller: string;
  let first: string;
  let second: string;
  let other: string;

  beforeAll(async () => {
    seller = await insertUser(handle, { name: "Vendedor Bloqueado", role: "SELLER", teamId: org.ids.teamA });
    first = await newLead(seller, "Negociação Um");
    second = await newLead(seller, "Negociação Dois");
    other = await newLead(seller, "Outro Lead");
    await setLeadStage(handle, first, "NEGOTIATION", -3);
    await setLeadStage(handle, second, "NEGOTIATION", -1);
  });

  it("não cadastra lead nem movimenta outro lead; consulta continua liberada", async () => {
    const ctx = await org.ctx(seller);
    const create = await createLead(ctx, { name: "Novo", phone: "(79) 98888-7777", interestCourseId: courseId }).catch((e: unknown) => e);
    expect(create).toBeInstanceOf(NegotiationOverdueError);
    expect((create as Error).message).toBe("Você possui 2 negociações vencidas. Atualize-as para continuar cadastrando ou movimentando leads.");
    await expect(moveLeadStage(ctx, other, { toStage: "NO_ANSWER" })).rejects.toBeInstanceOf(NegotiationOverdueError);
    expect((await rowOf(other)).stage).toBe("NEW");

    await expect(getLead(ctx, other)).resolves.toBeTruthy();
    await expect(getLeadTimeline(ctx, other)).resolves.toBeTruthy();
    expect((await listLeads(ctx)).total).toBe(3);
    expect(await getNegotiationBlock(ctx)).toMatchObject({ count: 2, leads: [{ id: first }, { id: second }] });
  });

  it("o bloqueio é só desse vendedor", async () => {
    await expect(createLead(await org.ctx(org.ids.sellerA2), { name: "Livre", phone: "(79) 98888-6666", interestCourseId: courseId })).resolves.toBeTruthy();
    expect(await getNegotiationBlock(await org.ctx(org.ids.sellerA2))).toEqual({ count: 0, leads: [] });
    expect(await getNegotiationBlock(await org.ctx(org.ids.supA))).toBeNull();
  });

  it("atualizar uma negociação renova o prazo dela, mas o bloqueio segue enquanto houver outra vencida", async () => {
    const ctx = await org.ctx(seller);
    await addLeadNote(ctx, first, { body: "Cliente vai decidir amanhã." });
    expect(hoursFromNow((await rowOf(first)).stageDueAt)).toBeCloseTo(24, 1);

    const error = await moveLeadStage(ctx, other, { toStage: "NO_ANSWER" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NegotiationOverdueError);
    expect((error as Error).message).toBe("Você possui uma negociação vencida. Atualize-a para continuar cadastrando ou movimentando leads.");
    expect((await getNegotiationBlock(ctx))?.count).toBe(1);
  });

  it("a própria negociação vencida pode ser movimentada", async () => {
    const lonely = await insertUser(handle, { name: "Vendedor Sozinho", role: "SELLER", teamId: org.ids.teamA });
    const negotiation = await newLead(lonely);
    await setLeadStage(handle, negotiation, "NEGOTIATION", -2);
    await expect(moveLeadStage(await org.ctx(lonely), negotiation, { toStage: "FOLLOW_UP_1" })).resolves.toMatchObject({ stage: "FOLLOW_UP_1" });
    expect((await getNegotiationBlock(await org.ctx(lonely)))?.count).toBe(0);
  });

  it("atualizadas todas, o bloqueio desaparece", async () => {
    const ctx = await org.ctx(seller);
    await addLeadNote(ctx, second, { body: "Proposta enviada." });
    expect(await getNegotiationBlock(ctx)).toEqual({ count: 0, leads: [] });
    await expect(moveLeadStage(ctx, other, { toStage: "NO_ANSWER" })).resolves.toMatchObject({ stage: "NO_ANSWER" });
    await expect(createLead(ctx, { name: "Agora Pode", phone: "(79) 98888-5555", interestCourseId: courseId })).resolves.toBeTruthy();
  });
});

describe("histórico e atomicidade", () => {
  it("STAGE_CHANGED registra ator, ciclo, de → para, responsável, equipe, supervisor e momento", async () => {
    const id = await newLead(org.ids.sellerA1);
    await moveLeadStage(await org.ctx(org.ids.sellerA1), id, { toStage: "NO_ANSWER" });
    const [cycle] = await handle.db.select().from(leadCycles).where(eq(leadCycles.leadId, id));
    const event = await lastEvent(id);
    expect(event).toMatchObject({
      type: "STAGE_CHANGED",
      actorId: org.ids.sellerA1,
      cycleId: cycle.id,
      fromStage: "NEW",
      stage: "NO_ANSWER",
      ownerId: org.ids.sellerA1,
      teamId: org.ids.teamA,
      supervisorId: org.ids.supA,
    });
    expect(Math.abs(event.occurredAt.getTime() - Date.now())).toBeLessThan(60_000);
    const timeline = await getLeadTimeline(await org.ctx(org.ids.sellerA1), id);
    expect(timeline.map((e) => e.type)).toEqual(["CREATED", "STAGE_CHANGED"]);
  });

  it("se o evento falhar, a mudança de etapa é desfeita", async () => {
    const id = await newLead(org.ids.sellerA1);
    const before = await rowOf(id);
    await handle.db.execute(sql`
      CREATE FUNCTION test_fail_stage_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falha simulada no evento de etapa'; END; $$
    `);
    await handle.db.execute(sql`
      CREATE TRIGGER test_fail_stage_event BEFORE INSERT ON lead_events
        FOR EACH ROW WHEN (NEW.type = 'STAGE_CHANGED') EXECUTE FUNCTION test_fail_stage_event()
    `);
    try {
      const error = await moveLeadStage(await org.ctx(org.ids.sellerA1), id, { toStage: "NEGOTIATION" }).catch((e: unknown) => e);
      expect((error as { cause?: Error }).cause?.message).toContain("falha simulada");
      expect(await rowOf(id)).toEqual(before);
    } finally {
      await handle.db.execute(sql`DROP TRIGGER test_fail_stage_event ON lead_events`);
      await handle.db.execute(sql`DROP FUNCTION test_fail_stage_event()`);
    }
  });
});
