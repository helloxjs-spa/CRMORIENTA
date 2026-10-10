import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { DatabaseHandle } from "@/server/db/connect";
import { leadCycles, leadEvents, leads, teams } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import {
  addLeadNote,
  createLead,
  editLead,
  getLead,
  getLeadTimeline,
  LeadAlreadyExistsError,
  listLeads,
  redistributeLead,
  restoreLead,
  transferLead,
  trashLead,
} from "@/server/modules/leads/leads.service";
import { teamHasOpenLeadsMessage, updateTeam } from "@/server/modules/teams/teams.service";
import { changeSellerTeam, SELLER_HAS_OPEN_LEADS, setUserActive } from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourse, setLeadStage } from "../support/leads";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let courseId: string;
let inactiveCourseId: string;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  courseId = await insertCourse(handle, "Pedagogia");
  inactiveCourseId = await insertCourse(handle, "Curso Encerrado", false);
});
afterAll(() => handle.close());

let phoneSeq = 0;
/** Celular válido e único por chamada, digitado no formato da interface. */
const nextPhone = () => `(79) 9${String(++phoneSeq).padStart(8, "0")}`;

async function newLead(sellerId: string, name = "Maria Souza") {
  return createLead(await org.ctx(sellerId), { name, phone: nextPhone(), interestCourseId: courseId });
}

const eventsOf = (leadId: string) => handle.db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId)).orderBy(asc(leadEvents.id));
const cyclesOf = (leadId: string) => handle.db.select().from(leadCycles).where(eq(leadCycles.leadId, leadId)).orderBy(asc(leadCycles.number));
const rowOf = async (leadId: string) => (await handle.db.select().from(leads).where(eq(leads.id, leadId)))[0];

describe("cadastro", () => {
  it("vendedor cadastra lead na própria carteira: Lead Cadastrado, ciclo 1 e evento com retrato da equipe", async () => {
    const lead = await createLead(await org.ctx(org.ids.sellerA1), {
      name: "  Ana Lima ",
      phone: "+55 (79) 98888-0001",
      interestCourseId: courseId,
    });
    expect(lead).toMatchObject({
      name: "Ana Lima",
      phone: "5579988880001",
      ownerId: org.ids.sellerA1,
      teamId: org.ids.teamA,
      teamName: "Equipe A",
      stage: "NEW",
      status: "ACTIVE",
      stageDueAt: null,
      cycleNumber: 1,
      interestCourseName: "Pedagogia",
    });
    expect(lead.createdAt).toBeInstanceOf(Date);

    const [cycle] = await cyclesOf(lead.id);
    expect(cycle).toMatchObject({ number: 1, kind: "INITIAL", assignedSellerId: org.ids.sellerA1, teamId: org.ids.teamA, endedAt: null });
    const [event] = await eventsOf(lead.id);
    expect(event).toMatchObject({
      type: "CREATED",
      cycleId: cycle.id,
      actorId: org.ids.sellerA1,
      stage: "NEW",
      ownerId: org.ids.sellerA1,
      teamId: org.ids.teamA,
      supervisorId: org.ids.supA,
    });
  });

  it("somente o vendedor cadastra (supervisor e admin não têm carteira)", async () => {
    for (const userId of [org.ids.supA, org.ids.admin]) {
      await expect(
        createLead(await org.ctx(userId), { name: "X Y", phone: nextPhone(), interestCourseId: courseId }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("valida nome, telefone, curso ativo e recusa campos não previstos", async () => {
    const ctx = await org.ctx(org.ids.sellerA1);
    const base = { name: "Fulano", phone: nextPhone(), interestCourseId: courseId };
    for (const input of [
      { ...base, name: "F" },
      { ...base, phone: "99999-9999" },
      { ...base, phone: "(79) 9999-9999" },
      { ...base, phone: "(20) 99999-9999" },
      { ...base, interestCourseId: undefined },
      { ...base, interestCourseId: inactiveCourseId },
      { ...base, ownerId: org.ids.sellerA2 },
      { ...base, teamId: org.ids.teamB },
      { ...base, stage: "NEGOTIATION" },
    ]) {
      await expect(createLead(ctx, input)).rejects.toBeInstanceOf(ValidationError);
    }
    const error = (await createLead(ctx, { ...base, phone: "(79) 9999-9999" }).catch((e: unknown) => e)) as ValidationError;
    expect(error.fieldErrors.phone).toEqual(["Celular deve ter o 9º dígito (ex.: (79) 99999-9999)."]);
  });

  it("vendedor sem equipe não cadastra", async () => {
    const loose = await insertUser(handle, { name: "Sem Equipe", role: "SELLER" });
    await expect(
      createLead(await org.ctx(loose), { name: "X Y", phone: nextPhone(), interestCourseId: courseId }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("duplicidade de telefone", () => {
  it("bloqueia o cadastro e informa só responsável e equipe, sem dar acesso ao lead", async () => {
    const original = await createLead(await org.ctx(org.ids.sellerA1), { name: "Bia", phone: "79 97777-0001", interestCourseId: courseId });
    const otherSeller = await org.ctx(org.ids.sellerB1);

    const error = await createLead(otherSeller, { name: "Outra", phone: "+55 79 97777-0001", interestCourseId: courseId }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LeadAlreadyExistsError);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe("Este lead já está cadastrado. Responsável: Vendedor A1 (equipe Equipe A).");
    expect((error as LeadAlreadyExistsError).existing).toEqual({ ownerName: "Vendedor A1", teamName: "Equipe A", inTrash: false });

    await expect(getLead(otherSeller, original.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLeadTimeline(otherSeller, original.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await handle.db.select().from(leads).where(eq(leads.phone, "5579977770001"))).toHaveLength(1);
  });

  it("cadastros simultâneos do mesmo telefone: só um é criado", async () => {
    const results = await Promise.allSettled([
      createLead(await org.ctx(org.ids.sellerA1), { name: "Corrida Um", phone: "79 96666-0001", interestCourseId: courseId }),
      createLead(await org.ctx(org.ids.sellerB1), { name: "Corrida Dois", phone: "(79) 96666-0001", interestCourseId: courseId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(LeadAlreadyExistsError);
    expect(await handle.db.select().from(leads).where(eq(leads.phone, "5579966660001"))).toHaveLength(1);
  });
});

describe("escopo e ownership", () => {
  let leadA1: string;
  let leadB1: string;

  beforeAll(async () => {
    leadA1 = (await newLead(org.ids.sellerA1, "Carla Escopo")).id;
    leadB1 = (await newLead(org.ids.sellerB1, "Davi Escopo")).id;
  });

  it("vendedor lista e abre só os próprios leads; trocar o ID dá NotFound", async () => {
    const a2 = await org.ctx(org.ids.sellerA2);
    expect((await listLeads(a2)).items.map((l) => l.id)).not.toContain(leadA1);
    expect((await listLeads(a2, { ownerId: org.ids.sellerA1 })).items).toEqual([]);
    await expect(getLead(a2, leadA1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLeadTimeline(a2, leadA1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addLeadNote(a2, leadA1, { body: "Invasão" })).rejects.toBeInstanceOf(NotFoundError);

    const a1 = await org.ctx(org.ids.sellerA1);
    const own = (await listLeads(a1)).items;
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((l) => l.ownerId === org.ids.sellerA1)).toBe(true);
  });

  it("supervisor vê os leads da equipe e não os de outra (nem por filtro)", async () => {
    const supA = await org.ctx(org.ids.supA);
    const list = (await listLeads(supA)).items;
    expect(list.every((l) => l.teamId === org.ids.teamA)).toBe(true);
    expect(list.map((l) => l.id)).toContain(leadA1);
    expect((await listLeads(supA, { teamId: org.ids.teamB })).items).toEqual([]);
    await expect(getLead(supA, leadB1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(transferLead(supA, leadB1, { toSellerId: org.ids.sellerA1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(trashLead(supA, leadB1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("administrador vê leads de todas as equipes", async () => {
    const ids = (await listLeads(await org.ctx(org.ids.admin))).items.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining([leadA1, leadB1]));
  });

  it("vendedor não transfere, redistribui, envia para a Lixeira, recupera nem vê a fila", async () => {
    const a1 = await org.ctx(org.ids.sellerA1);
    await expect(transferLead(a1, leadA1, { toSellerId: org.ids.sellerA2 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(redistributeLead(a1, leadA1, { toSellerId: org.ids.sellerA2 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(trashLead(a1, leadA1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(restoreLead(a1, leadA1, { toSellerId: org.ids.sellerA1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listLeads(a1, { queue: "ALL" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("busca por nome ou trecho do telefone", async () => {
    const supA = await org.ctx(org.ids.supA);
    expect((await listLeads(supA, { search: "carla" })).items.map((l) => l.id)).toEqual([leadA1]);
    const { phone } = await rowOf(leadA1);
    const formatted = `(79) ${phone.slice(4, 9)}-${phone.slice(9)}`;
    expect((await listLeads(supA, { search: formatted })).items.map((l) => l.id)).toEqual([leadA1]);
  });
});

describe("observações", () => {
  it("o vendedor responsável registra; vira evento com autor e texto, no ciclo atual", async () => {
    const lead = await newLead(org.ids.sellerA1);
    await addLeadNote(await org.ctx(org.ids.sellerA1), lead.id, { body: "  Pediu informações sobre a bolsa.  " });

    const timeline = await getLeadTimeline(await org.ctx(org.ids.sellerA1), lead.id);
    expect(timeline.map((e) => e.type)).toEqual(["CREATED", "NOTE_ADDED"]);
    expect(timeline[1]).toMatchObject({ actorName: "Vendedor A1", note: "Pediu informações sobre a bolsa.", cycleNumber: 1, stage: "NEW" });
  });

  it("supervisor e admin não registram observação; texto vazio é recusado", async () => {
    const lead = await newLead(org.ids.sellerA1);
    await expect(addLeadNote(await org.ctx(org.ids.supA), lead.id, { body: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addLeadNote(await org.ctx(org.ids.admin), lead.id, { body: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addLeadNote(await org.ctx(org.ids.sellerA1), lead.id, { body: "   " })).rejects.toBeInstanceOf(ValidationError);
  });

  it("em Negociação, uma observação renova o prazo por 24 horas", async () => {
    const lead = await newLead(org.ids.sellerA1);
    await setLeadStage(handle, lead.id, "NEGOTIATION", -2);
    const before = Date.now();
    await addLeadNote(await org.ctx(org.ids.sellerA1), lead.id, { body: "Enviou documentos." });

    const { stageDueAt } = await rowOf(lead.id);
    const expected = before + BUSINESS_RULES.negotiationDeadlineHours * 3_600_000;
    expect(Math.abs(stageDueAt!.getTime() - expected)).toBeLessThan(60_000);
  });
});

describe("transferência", () => {
  it("supervisor transfere dentro da equipe mantendo etapa, entrada, prazo e ciclo", async () => {
    const lead = await newLead(org.ids.sellerA1);
    await setLeadStage(handle, lead.id, "FOLLOW_UP_1", 10);
    const before = await rowOf(lead.id);
    const [cycleBefore] = await cyclesOf(lead.id);

    await transferLead(await org.ctx(org.ids.supA), lead.id, { toSellerId: org.ids.sellerA2 });

    const after = await rowOf(lead.id);
    expect(after).toMatchObject({ ownerId: org.ids.sellerA2, teamId: org.ids.teamA, stage: "FOLLOW_UP_1" });
    expect(after.stageEnteredAt).toEqual(before.stageEnteredAt);
    expect(after.stageDueAt).toEqual(before.stageDueAt);
    expect(await cyclesOf(lead.id)).toEqual([cycleBefore]);

    const transfer = (await eventsOf(lead.id)).at(-1)!;
    expect(transfer).toMatchObject({
      type: "TRANSFERRED",
      cycleId: cycleBefore.id,
      actorId: org.ids.supA,
      fromOwnerId: org.ids.sellerA1,
      ownerId: org.ids.sellerA2,
      teamId: org.ids.teamA,
      fromTeamId: null,
      supervisorId: org.ids.supA,
    });

    await expect(getLead(await org.ctx(org.ids.sellerA1), lead.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLead(await org.ctx(org.ids.sellerA2), lead.id)).resolves.toMatchObject({ id: lead.id });
  });

  it("supervisor não transfere para vendedor de outra equipe nem para o mesmo responsável", async () => {
    const lead = await newLead(org.ids.sellerA1);
    const supA = await org.ctx(org.ids.supA);
    await expect(transferLead(supA, lead.id, { toSellerId: org.ids.sellerB1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(transferLead(supA, lead.id, { toSellerId: org.ids.sellerA1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(transferLead(supA, lead.id, { toSellerId: org.ids.supA })).rejects.toBeInstanceOf(ValidationError);
    expect((await rowOf(lead.id)).ownerId).toBe(org.ids.sellerA1);
  });

  it("admin transfere entre equipes; o escopo dos supervisores acompanha", async () => {
    const lead = await newLead(org.ids.sellerA1);
    await transferLead(await org.ctx(org.ids.admin), lead.id, { toSellerId: org.ids.sellerB1 });

    expect(await rowOf(lead.id)).toMatchObject({ ownerId: org.ids.sellerB1, teamId: org.ids.teamB });
    expect((await eventsOf(lead.id)).at(-1)).toMatchObject({
      type: "TRANSFERRED",
      fromOwnerId: org.ids.sellerA1,
      ownerId: org.ids.sellerB1,
      fromTeamId: org.ids.teamA,
      teamId: org.ids.teamB,
      fromSupervisorId: org.ids.supA,
      supervisorId: org.ids.supB,
    });
    await expect(getLead(await org.ctx(org.ids.supA), lead.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLead(await org.ctx(org.ids.supB), lead.id)).resolves.toMatchObject({ teamName: "Equipe B" });
  });
});

describe("desativação do vendedor → fila do supervisor", () => {
  let seller: string;
  let inNegotiation: string;
  let inFollowUp: string;

  beforeAll(async () => {
    seller = await insertUser(handle, { name: "Vendedor Saindo", role: "SELLER", teamId: org.ids.teamA });
    inNegotiation = (await newLead(seller, "Lead Negociação")).id;
    inFollowUp = (await newLead(seller, "Lead Follow")).id;
    await setLeadStage(handle, inNegotiation, "NEGOTIATION", 5);
    await setLeadStage(handle, inFollowUp, "FOLLOW_UP_2", 5);
  });

  it("desativar deixa os leads sem responsável, na mesma equipe, sem Retrabalho", async () => {
    const before = await rowOf(inNegotiation);
    await setUserActive(await org.ctx(org.ids.admin), seller, false);

    const after = await rowOf(inNegotiation);
    expect(after).toMatchObject({ ownerId: null, teamId: org.ids.teamA, stage: "NEGOTIATION", unassignedReason: "OWNER_DEACTIVATED" });
    expect(after.stageDueAt).toEqual(before.stageDueAt);
    expect(after.unassignedAt).toBeInstanceOf(Date);
    expect((await cyclesOf(inNegotiation)).map((c) => [c.number, c.endedAt])).toEqual([[1, null]]);

    expect((await eventsOf(inNegotiation)).at(-1)).toMatchObject({
      type: "UNASSIGNED",
      actorId: org.ids.admin,
      ownerId: null,
      fromOwnerId: seller,
      teamId: org.ids.teamA,
      supervisorId: org.ids.supA,
      unassignedReason: "OWNER_DEACTIVATED",
      stage: "NEGOTIATION",
    });
  });

  it("os leads entram na fila do supervisor da equipe (e só dele)", async () => {
    const queueA = (await listLeads(await org.ctx(org.ids.supA), { queue: "ALL", pageSize: 100 })).items;
    expect(queueA.filter((q) => [inNegotiation, inFollowUp].includes(q.id)).map((q) => q.queueReason)).toEqual([
      "UNASSIGNED",
      "UNASSIGNED",
    ]);
    const queueB = (await listLeads(await org.ctx(org.ids.supB), { queue: "ALL", pageSize: 100 })).items;
    expect(queueB.map((q) => q.id)).not.toContain(inNegotiation);
    expect((await listLeads(await org.ctx(org.ids.supA), { queue: "UNASSIGNED" })).items.map((l) => l.id)).toEqual(
      expect.arrayContaining([inNegotiation, inFollowUp]),
    );
  });

  it("reativar o vendedor não devolve os leads", async () => {
    await setUserActive(await org.ctx(org.ids.admin), seller, true);
    expect((await rowOf(inNegotiation)).ownerId).toBeNull();
  });

  it("transferência administrativa da fila mantém etapa, prazo e ciclo", async () => {
    const before = await rowOf(inNegotiation);
    await transferLead(await org.ctx(org.ids.supA), inNegotiation, { toSellerId: org.ids.sellerA1 });

    const after = await rowOf(inNegotiation);
    expect(after).toMatchObject({ ownerId: org.ids.sellerA1, unassignedAt: null, unassignedReason: null, stage: "NEGOTIATION" });
    expect(after.stageDueAt).toEqual(before.stageDueAt);
    expect((await cyclesOf(inNegotiation)).map((c) => c.number)).toEqual([1]);
    expect((await eventsOf(inNegotiation)).at(-1)).toMatchObject({
      type: "TRANSFERRED",
      fromOwnerId: null,
      ownerId: org.ids.sellerA1,
      metadata: { fromQueue: true, unassignedReason: "OWNER_DEACTIVATED" },
    });
  });

  it("supervisor envia lead da fila para a Lixeira sem atribuir vendedor; o histórico guarda o vendedor anterior", async () => {
    await trashLead(await org.ctx(org.ids.supA), inFollowUp);
    expect(await rowOf(inFollowUp)).toMatchObject({
      status: "TRASHED",
      ownerId: null,
      teamId: org.ids.teamA,
      stage: "FOLLOW_UP_2",
      unassignedReason: "OWNER_DEACTIVATED",
      trashedBy: org.ids.supA,
    });
    const timeline = await getLeadTimeline(await org.ctx(org.ids.supA), inFollowUp);
    expect(timeline.map((e) => e.type)).toEqual(["CREATED", "UNASSIGNED", "TRASHED"]);
    expect(timeline[1]).toMatchObject({ fromOwnerName: "Vendedor Saindo", teamName: "Equipe A", supervisorName: "Supervisor A" });
  });
});

describe("troca de equipe do vendedor", () => {
  it("os leads em operação acompanham o vendedor, com evento TEAM_CHANGED", async () => {
    const seller = await insertUser(handle, { name: "Vendedor Mudando", role: "SELLER", teamId: org.ids.teamA });
    const lead = await newLead(seller);
    await changeSellerTeam(await org.ctx(org.ids.admin), seller, { teamId: org.ids.teamB });

    expect(await rowOf(lead.id)).toMatchObject({ ownerId: seller, teamId: org.ids.teamB });
    expect((await eventsOf(lead.id)).at(-1)).toMatchObject({
      type: "TEAM_CHANGED",
      fromTeamId: org.ids.teamA,
      teamId: org.ids.teamB,
      fromSupervisorId: org.ids.supA,
      supervisorId: org.ids.supB,
      ownerId: seller,
    });
    await expect(getLead(await org.ctx(org.ids.supA), lead.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLead(await org.ctx(org.ids.supB), lead.id)).resolves.toBeTruthy();
  });

  it("remover da equipe com leads em aberto é recusado; sem leads em aberto é permitido", async () => {
    const seller = await insertUser(handle, { name: "Vendedor Removido", role: "SELLER", teamId: org.ids.teamA });
    const lead = await newLead(seller);
    const admin = await org.ctx(org.ids.admin);

    const error = await changeSellerTeam(admin, seller, { teamId: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe(SELLER_HAS_OPEN_LEADS);

    await transferLead(await org.ctx(org.ids.supA), lead.id, { toSellerId: org.ids.sellerA1 });
    await expect(changeSellerTeam(admin, seller, { teamId: null })).resolves.toBeUndefined();
  });
});

describe("Follow-up 3 vencido → redistribuição (Retrabalho)", () => {
  it("só redistribui com Follow-up 3 vencido", async () => {
    const lead = await newLead(org.ids.sellerA1);
    const supA = await org.ctx(org.ids.supA);
    await expect(redistributeLead(supA, lead.id, { toSellerId: org.ids.sellerA2 })).rejects.toBeInstanceOf(ValidationError);
    await setLeadStage(handle, lead.id, "FOLLOW_UP_3", 3);
    await expect(redistributeLead(supA, lead.id, { toSellerId: org.ids.sellerA2 })).rejects.toBeInstanceOf(ValidationError);
    expect((await listLeads(supA, { queue: "ALL", pageSize: 100 })).items.map((q) => q.id)).not.toContain(lead.id);
  });

  it("FU3 vencido aparece na fila; redistribuir abre ciclo 2 REWORK com o novo vendedor", async () => {
    const lead = await newLead(org.ids.sellerA1);
    await setLeadStage(handle, lead.id, "FOLLOW_UP_3", -1);
    const supA = await org.ctx(org.ids.supA);

    const item = (await listLeads(supA, { queue: "ALL", pageSize: 100 })).items.find((q) => q.id === lead.id);
    expect(item).toMatchObject({ queueReason: "FOLLOW_UP_3_EXPIRED", ownerId: org.ids.sellerA1 });
    await expect(redistributeLead(await org.ctx(org.ids.supB), lead.id, { toSellerId: org.ids.sellerB1 })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    await redistributeLead(supA, lead.id, { toSellerId: org.ids.sellerA2 });

    expect(await rowOf(lead.id)).toMatchObject({ ownerId: org.ids.sellerA2, stage: "REWORK", stageDueAt: null, status: "ACTIVE" });
    const cycles = await cyclesOf(lead.id);
    expect(cycles.map((c) => [c.number, c.kind, c.endReason, c.assignedSellerId])).toEqual([
      [1, "INITIAL", "REDISTRIBUTED", org.ids.sellerA1],
      [2, "REWORK", null, org.ids.sellerA2],
    ]);
    expect((await eventsOf(lead.id)).at(-1)).toMatchObject({
      type: "REDISTRIBUTED",
      cycleId: cycles[1].id,
      stage: "REWORK",
      fromStage: "FOLLOW_UP_3",
      fromOwnerId: org.ids.sellerA1,
      ownerId: org.ids.sellerA2,
    });
    expect((await listLeads(supA, { queue: "ALL", pageSize: 100 })).items.map((q) => q.id)).not.toContain(lead.id);
    await expect(getLead(await org.ctx(org.ids.sellerA1), lead.id)).rejects.toBeInstanceOf(NotFoundError);

    // Cada fato aponta para o seu ciclo: o atendimento inicial e o retrabalho são distinguíveis.
    const timeline = await getLeadTimeline(await org.ctx(org.ids.sellerA2), lead.id);
    expect(timeline.map((e) => [e.type, e.cycleNumber, e.cycleKind])).toEqual([
      ["CREATED", 1, "INITIAL"],
      ["REDISTRIBUTED", 2, "REWORK"],
    ]);
  });
});

describe("Lixeira e recuperação", () => {
  let lead: { id: string; phone: string };

  beforeAll(async () => {
    lead = await newLead(org.ids.sellerA1, "Lead Lixeira");
    await setLeadStage(handle, lead.id, "NO_ANSWER");
  });

  it("supervisor envia para a Lixeira: encerra o ciclo e preserva etapa e responsável", async () => {
    await trashLead(await org.ctx(org.ids.supA), lead.id);
    expect(await rowOf(lead.id)).toMatchObject({ status: "TRASHED", stage: "NO_ANSWER", ownerId: org.ids.sellerA1, trashedBy: org.ids.supA });
    expect((await cyclesOf(lead.id)).map((c) => c.endReason)).toEqual(["TRASHED"]);
    expect((await eventsOf(lead.id)).at(-1)).toMatchObject({ type: "TRASHED", actorId: org.ids.supA, stage: "NO_ANSWER" });
  });

  it("o vendedor deixa de ver o lead; supervisor e admin continuam vendo", async () => {
    await expect(getLead(await org.ctx(org.ids.sellerA1), lead.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listLeads(await org.ctx(org.ids.sellerA1))).items.map((l) => l.id)).not.toContain(lead.id);
    await expect(getLead(await org.ctx(org.ids.supA), lead.id)).resolves.toMatchObject({ status: "TRASHED", cycleNumber: null });
    expect((await listLeads(await org.ctx(org.ids.admin), { status: "TRASHED" })).items.map((l) => l.id)).toContain(lead.id);
  });

  it("telefone na Lixeira continua ocupado, com a mensagem combinada", async () => {
    const error = await createLead(await org.ctx(org.ids.sellerB1), {
      name: "Nova Tentativa",
      phone: lead.phone,
      interestCourseId: courseId,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LeadAlreadyExistsError);
    expect((error as Error).message).toBe(
      "Este lead já está cadastrado e encontra-se na Lixeira. Solicite ao supervisor ou administrador a recuperação.",
    );
  });

  it("não transfere, nem envia de novo, um lead que está na Lixeira", async () => {
    const supA = await org.ctx(org.ids.supA);
    await expect(transferLead(supA, lead.id, { toSellerId: org.ids.sellerA2 })).rejects.toBeInstanceOf(ValidationError);
    await expect(trashLead(supA, lead.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("recuperação: supervisor só dentro da equipe; supervisor de outra equipe não enxerga", async () => {
    await expect(restoreLead(await org.ctx(org.ids.supA), lead.id, { toSellerId: org.ids.sellerB1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(restoreLead(await org.ctx(org.ids.supB), lead.id, { toSellerId: org.ids.sellerB1 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(restoreLead(await org.ctx(org.ids.supA), (await newLead(org.ids.sellerA1)).id, { toSellerId: org.ids.sellerA2 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("admin recupera para vendedor de outra equipe: Retrabalho, novo ciclo e histórico preservado", async () => {
    await restoreLead(await org.ctx(org.ids.admin), lead.id, { toSellerId: org.ids.sellerB1 });

    expect(await rowOf(lead.id)).toMatchObject({
      status: "ACTIVE",
      stage: "REWORK",
      stageDueAt: null,
      ownerId: org.ids.sellerB1,
      teamId: org.ids.teamB,
      trashedAt: null,
      trashedBy: null,
    });
    expect((await cyclesOf(lead.id)).map((c) => [c.number, c.kind, c.endReason])).toEqual([
      [1, "INITIAL", "TRASHED"],
      [2, "REWORK", null],
    ]);
    const timeline = await getLeadTimeline(await org.ctx(org.ids.sellerB1), lead.id);
    expect(timeline.map((e) => e.type)).toEqual(["CREATED", "TRASHED", "RESTORED"]);
    expect(timeline[2]).toMatchObject({
      actorName: "Admin",
      fromStage: "NO_ANSWER",
      stage: "REWORK",
      fromOwnerName: "Vendedor A1",
      ownerName: "Vendedor B1",
      fromTeamName: "Equipe A",
      teamName: "Equipe B",
      fromSupervisorName: "Supervisor A",
      supervisorName: "Supervisor B",
      cycleNumber: 2,
    });
  });
});

describe("histórico", () => {
  it("o retrato do supervisor nos eventos não muda quando a equipe troca de supervisor", async () => {
    const team = (await handle.db.insert(teams).values({ name: "Equipe C" }).returning())[0];
    const supC1 = await insertUser(handle, { name: "Supervisor C1", role: "SUPERVISOR" });
    const supC2 = await insertUser(handle, { name: "Supervisor C2", role: "SUPERVISOR" });
    await handle.db.update(teams).set({ supervisorId: supC1 }).where(eq(teams.id, team.id));
    const seller = await insertUser(handle, { name: "Vendedor C", role: "SELLER", teamId: team.id });
    const lead = await newLead(seller);

    await handle.db.update(teams).set({ supervisorId: supC2 }).where(eq(teams.id, team.id));

    const [created] = await getLeadTimeline(await org.ctx(supC2), lead.id);
    expect(created).toMatchObject({ type: "CREATED", supervisorName: "Supervisor C1" });
    await expect(getLead(await org.ctx(supC1), lead.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("edição de lead (nome, telefone, curso de interesse)", () => {
  let otherCourseId: string;

  beforeAll(async () => {
    otherCourseId = await insertCourse(handle, "História");
  });

  const detailsEvents = async (leadId: string) => (await eventsOf(leadId)).filter((e) => e.type === "DETAILS_UPDATED");

  it("vendedor edita o próprio lead: nome com espaços removidos e telefone normalizado", async () => {
    const lead = await newLead(org.ids.sellerA1, "Maria Silva");
    const before = await rowOf(lead.id);
    const edited = await editLead(await org.ctx(org.ids.sellerA1), lead.id, { name: "  Maria Santos  ", phone: "+55 79 95555-0001" });

    expect(edited).toMatchObject({ name: "Maria Santos", phone: "5579955550001" });
    const after = await rowOf(lead.id);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    const [event] = await detailsEvents(lead.id);
    expect(event.metadata).toEqual({
      name: { from: "Maria Silva", to: "Maria Santos" },
      phone: { from: before.phone, to: "5579955550001" },
    });
  });

  it("formatos diferentes do mesmo telefone não contam como mudança", async () => {
    const lead = await newLead(org.ids.sellerA1);
    const seller = await org.ctx(org.ids.sellerA1);
    await editLead(seller, lead.id, { phone: "(79) 95555-0002" });
    for (const phone of ["79 95555-0002", "+55 79 95555-0002", "5579955550002"]) await editLead(seller, lead.id, { phone });
    expect(await detailsEvents(lead.id)).toHaveLength(1);
    expect((await rowOf(lead.id)).phone).toBe("5579955550002");
  });

  it("vendedor não edita lead de outro vendedor (mesma equipe ou não): NotFound e nada muda", async () => {
    const ofA2 = await newLead(org.ids.sellerA2, "Lead do A2");
    const ofB1 = await newLead(org.ids.sellerB1, "Lead do B1");
    const a1 = await org.ctx(org.ids.sellerA1);
    await expect(editLead(a1, ofA2.id, { name: "Invadido" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(editLead(a1, ofB1.id, { name: "Invadido" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await rowOf(ofA2.id)).name).toBe("Lead do A2");
    expect(await detailsEvents(ofA2.id)).toHaveLength(0);
  });

  it("supervisor edita leads da própria equipe e não os de outra", async () => {
    const ofA2 = await newLead(org.ids.sellerA2, "Lead Equipe A");
    const ofB1 = await newLead(org.ids.sellerB1, "Lead Equipe B");
    const supA = await org.ctx(org.ids.supA);
    await expect(editLead(supA, ofA2.id, { name: "Corrigido pelo Supervisor" })).resolves.toMatchObject({
      name: "Corrigido pelo Supervisor",
    });
    await expect(editLead(supA, ofB1.id, { name: "Invadido" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await rowOf(ofB1.id)).name).toBe("Lead Equipe B");
  });

  it("admin edita lead de qualquer equipe", async () => {
    const ofB1 = await newLead(org.ids.sellerB1, "Lead Admin");
    await expect(editLead(await org.ctx(org.ids.admin), ofB1.id, { name: "Editado pelo Admin" })).resolves.toMatchObject({
      name: "Editado pelo Admin",
    });
    expect((await detailsEvents(ofB1.id))[0]).toMatchObject({ actorId: org.ids.admin, ownerId: org.ids.sellerB1, teamId: org.ids.teamB });
  });

  it("lead na Lixeira não pode ser editado (o vendedor nem o enxerga)", async () => {
    const lead = await newLead(org.ids.sellerA1, "Lead Descartado");
    await trashLead(await org.ctx(org.ids.supA), lead.id);
    await expect(editLead(await org.ctx(org.ids.supA), lead.id, { name: "Novo Nome" })).rejects.toBeInstanceOf(ValidationError);
    await expect(editLead(await org.ctx(org.ids.admin), lead.id, { name: "Novo Nome" })).rejects.toBeInstanceOf(ValidationError);
    await expect(editLead(await org.ctx(org.ids.sellerA1), lead.id, { name: "Novo Nome" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await rowOf(lead.id)).name).toBe("Lead Descartado");
  });

  it("valida nome e telefone e recusa campos de outras operações", async () => {
    const lead = await newLead(org.ids.sellerA1);
    const seller = await org.ctx(org.ids.sellerA1);
    for (const input of [
      { name: "" },
      { name: "   " },
      { phone: "99999-9999" },
      { phone: "(79) 9999-9999" },
      { interestCourseId: null },
      { ownerId: org.ids.sellerA2 },
      { teamId: org.ids.teamB },
      { stage: "NEGOTIATION" },
      { status: "TRASHED" },
      { stageDueAt: new Date() },
    ]) {
      await expect(editLead(seller, lead.id, input)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await detailsEvents(lead.id)).toHaveLength(0);
  });

  it("telefone de outro lead ativo: bloqueia com responsável e equipe, sem alterar nada", async () => {
    const existing = await createLead(await org.ctx(org.ids.sellerB1), { name: "Dono", phone: "79 95555-0100", interestCourseId: courseId });
    const lead = await newLead(org.ids.sellerA1, "Tentando Duplicar");
    const before = await rowOf(lead.id);

    const error = await editLead(await org.ctx(org.ids.sellerA1), lead.id, { name: "Outro Nome", phone: "(79) 95555-0100" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LeadAlreadyExistsError);
    expect((error as Error).message).toBe("Este telefone já pertence a outro lead. Responsável: Vendedor B1 (equipe Equipe B).");
    expect(await rowOf(lead.id)).toEqual(before);
    expect(await detailsEvents(lead.id)).toHaveLength(0);
    expect((await rowOf(existing.id)).phone).toBe("5579955550100");
  });

  it("telefone de lead na Lixeira: bloqueia com a mensagem da Lixeira", async () => {
    const trashed = await createLead(await org.ctx(org.ids.sellerA2), { name: "Na Lixeira", phone: "79 95555-0200", interestCourseId: courseId });
    await trashLead(await org.ctx(org.ids.supA), trashed.id);
    const lead = await newLead(org.ids.sellerA1);
    const before = await rowOf(lead.id);

    const error = await editLead(await org.ctx(org.ids.supA), lead.id, { phone: "+55 79 95555-0200" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LeadAlreadyExistsError);
    expect((error as Error).message).toBe(
      "Este telefone já pertence a um lead que está na Lixeira. Solicite ao supervisor ou administrador a recuperação daquele lead.",
    );
    expect(await rowOf(lead.id)).toEqual(before);
  });

  it("edições simultâneas para o mesmo telefone: a constraint UNIQUE deixa só uma passar", async () => {
    const first = await newLead(org.ids.sellerA1);
    const second = await newLead(org.ids.sellerA2);
    const results = await Promise.allSettled([
      editLead(await org.ctx(org.ids.sellerA1), first.id, { phone: "79 95555-0300" }),
      editLead(await org.ctx(org.ids.sellerA2), second.id, { phone: "(79) 95555-0300" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(LeadAlreadyExistsError);
    expect(await handle.db.select().from(leads).where(eq(leads.phone, "5579955550300"))).toHaveLength(1);
  });

  it("troca para outro curso ativo, com IDs e descrição no histórico", async () => {
    const lead = await newLead(org.ids.sellerA1);
    const edited = await editLead(await org.ctx(org.ids.sellerA1), lead.id, { interestCourseId: otherCourseId });
    expect(edited).toMatchObject({ interestCourseId: otherCourseId, interestCourseName: "História" });
    expect((await detailsEvents(lead.id))[0].metadata).toEqual({
      interestCourse: {
        from: { id: courseId, name: "Pedagogia", institutionName: "Faculdade Teste" },
        to: { id: otherCourseId, name: "História", institutionName: "Faculdade Teste" },
      },
    });
  });

  it("curso inexistente ou inativo é recusado", async () => {
    const lead = await newLead(org.ids.sellerA1);
    const seller = await org.ctx(org.ids.sellerA1);
    for (const interestCourseId of [inactiveCourseId, "00000000-0000-4000-8000-000000000000"]) {
      const error = (await editLead(seller, lead.id, { interestCourseId }).catch((e: unknown) => e)) as ValidationError;
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.fieldErrors.interestCourseId).toEqual(["Selecione um curso ativo."]);
    }
    expect((await rowOf(lead.id)).interestCourseId).toBe(courseId);
  });

  it("DETAILS_UPDATED guarda ator, responsável, equipe, supervisor, etapa e ciclo; nada operacional muda", async () => {
    const lead = await newLead(org.ids.sellerA1, "Lead Em Follow");
    await setLeadStage(handle, lead.id, "FOLLOW_UP_2", 7);
    const before = await rowOf(lead.id);
    const cyclesBefore = await cyclesOf(lead.id);

    await editLead(await org.ctx(org.ids.supA), lead.id, { name: "Lead Corrigido", phone: "79 95555-0400", interestCourseId: otherCourseId });

    const after = await rowOf(lead.id);
    expect(after.ownerId).toBe(before.ownerId);
    expect(after.teamId).toBe(before.teamId);
    expect(after.stage).toBe("FOLLOW_UP_2");
    expect(after.status).toBe("ACTIVE");
    expect(after.stageEnteredAt).toEqual(before.stageEnteredAt);
    expect(after.stageDueAt).toEqual(before.stageDueAt);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(await cyclesOf(lead.id)).toEqual(cyclesBefore);

    const [event] = await detailsEvents(lead.id);
    expect(event).toMatchObject({
      cycleId: cyclesBefore[0].id,
      actorId: org.ids.supA,
      ownerId: org.ids.sellerA1,
      teamId: org.ids.teamA,
      supervisorId: org.ids.supA,
      stage: "FOLLOW_UP_2",
      fromStage: null,
      fromOwnerId: null,
      fromTeamId: null,
    });
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(Object.keys(event.metadata).sort()).toEqual(["interestCourse", "name", "phone"]);

    const timeline = await getLeadTimeline(await org.ctx(org.ids.sellerA1), lead.id);
    expect(timeline.at(-1)).toMatchObject({ type: "DETAILS_UPDATED", actorName: "Supervisor A", cycleNumber: 1 });
  });

  it("edição sem mudança real não grava nada nem cria evento", async () => {
    const lead = await newLead(org.ids.sellerA1, "Sem Mudança");
    const before = await rowOf(lead.id);
    await editLead(await org.ctx(org.ids.sellerA1), lead.id, { name: " Sem Mudança ", phone: before.phone, interestCourseId: courseId });
    await editLead(await org.ctx(org.ids.sellerA1), lead.id, {});
    expect(await rowOf(lead.id)).toEqual(before);
    expect(await detailsEvents(lead.id)).toHaveLength(0);
  });

  it("se a gravação do evento falhar, a edição é desfeita (rollback)", async () => {
    const lead = await newLead(org.ids.sellerA1, "Antes da Falha");
    const before = await rowOf(lead.id);
    await handle.db.execute(sql`
      CREATE FUNCTION test_fail_details_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falha simulada no evento'; END; $$
    `);
    await handle.db.execute(sql`
      CREATE TRIGGER test_fail_details_event BEFORE INSERT ON lead_events
        FOR EACH ROW WHEN (NEW.type = 'DETAILS_UPDATED') EXECUTE FUNCTION test_fail_details_event()
    `);
    try {
      const error = await editLead(await org.ctx(org.ids.sellerA1), lead.id, { name: "Depois da Falha", phone: "79 95555-0500" }).catch(
        (e: unknown) => e,
      );
      expect((error as { cause?: Error }).cause?.message).toContain("falha simulada");
      expect(await rowOf(lead.id)).toEqual(before);
      expect(await detailsEvents(lead.id)).toHaveLength(0);
    } finally {
      await handle.db.execute(sql`DROP TRIGGER test_fail_details_event ON lead_events`);
      await handle.db.execute(sql`DROP FUNCTION test_fail_details_event()`);
    }
  });
});

describe("inativação de equipe com leads ativos", () => {
  it("bloqueia enquanto houver leads em operação (inclusive sem responsável); Lixeira não impede", async () => {
    const admin = await org.ctx(org.ids.admin);
    const team = (await handle.db.insert(teams).values({ name: "Equipe D" }).returning())[0];
    const seller = await insertUser(handle, { name: "Vendedor D", role: "SELLER", teamId: team.id });
    const open = await newLead(seller, "Lead Aberto D");
    const trashed = await newLead(seller, "Lead Lixeira D");
    await trashLead(admin, trashed.id);

    // Com vendedor ativo, a regra que já existia barra a inativação.
    await expect(updateTeam(admin, team.id, { active: false })).rejects.toBeInstanceOf(ConflictError);

    // Sem vendedores ativos, o lead que ficou na fila (sem responsável) ainda impede.
    await setUserActive(admin, seller, false);
    const error = await updateTeam(admin, team.id, { active: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe(teamHasOpenLeadsMessage(1));
    expect((await handle.db.select().from(teams).where(eq(teams.id, team.id)))[0].active).toBe(true);

    // Resolvido (transferido), a equipe é inativada mesmo com lead na Lixeira.
    await transferLead(admin, open.id, { toSellerId: org.ids.sellerA1 });
    await expect(updateTeam(admin, team.id, { active: false })).resolves.toMatchObject({ active: false });
    expect(await rowOf(trashed.id)).toMatchObject({ status: "TRASHED", teamId: team.id });
  });
});
