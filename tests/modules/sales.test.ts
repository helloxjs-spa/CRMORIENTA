import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { DatabaseHandle } from "@/server/db/connect";
import { leadCycles, leadEvents, leads, saleEvents, saleItems, sales, teams, users } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "@/server/errors";
import { updateCourse } from "@/server/modules/courses/courses.service";
import { createLead, getLeadTimeline, trashLead } from "@/server/modules/leads/leads.service";
import {
  COURSE_NOT_AVAILABLE,
  createSale,
  getSale,
  getSaleHistory,
  getSaleWithCost,
  LEAD_IN_TRASH,
  listSales,
  REQUEST_ID_REUSED,
  SELLER_NOT_ACTIVE,
  SELLER_OUTSIDE_TEAM,
  SELLER_REQUIRED,
  SELLER_TEAM_INACTIVE,
} from "@/server/modules/sales/sales.service";
import { changeSellerTeam } from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { setLeadStage } from "../support/leads";
import { insertCourseWithCost, saleInput } from "../support/sales";

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

const nextPhone = () => `(79) 95${String(++seq).padStart(7, "0")}`;
const ctx = (userId: string) => org.ctx(userId);

async function newLead(sellerId: string = org.ids.sellerA1): Promise<string> {
  return (await createLead(await ctx(sellerId), { name: `Cliente ${seq}`, phone: nextPhone(), interestCourseId: course })).id;
}

const leadRow = async (id: string) => (await handle.db.select().from(leads).where(eq(leads.id, id)))[0];
const saleRow = async (id: string) => (await handle.db.select().from(sales).where(eq(sales.id, id)))[0];
const itemsOf = (saleId: string) => handle.db.select().from(saleItems).where(eq(saleItems.saleId, saleId)).orderBy(asc(saleItems.id));
const leadEventsOf = (leadId: string) => handle.db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId)).orderBy(asc(leadEvents.id));
const saleEventsOf = (saleId: string) => handle.db.select().from(saleEvents).where(eq(saleEvents.saleId, saleId)).orderBy(asc(saleEvents.id));
const cyclesOf = (leadId: string) => handle.db.select().from(leadCycles).where(eq(leadCycles.leadId, leadId)).orderBy(asc(leadCycles.number));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(new Date());

async function expectValidation(promise: Promise<unknown>, message: string): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  const v = error as ValidationError;
  expect([v.message, ...Object.values(v.fieldErrors).flat()]).toContain(message);
}

/** Nada da venda foi gravado e o lead ficou como estava. */
async function expectNothingWritten(leadId: string, requestId: string, leadBefore: unknown): Promise<void> {
  expect(await saleRow(requestId)).toBeUndefined();
  expect(await leadRow(leadId)).toEqual(leadBefore);
}

// ---------------------------------------------------------------------------

describe("registro de venda", () => {
  it("Pix pelo próprio vendedor: venda, itens com snapshots, lead em Fechamento, ciclo WON e auditoria", async () => {
    const leadId = await newLead();
    const input = saleInput(leadId, course);
    const result = await createSale(await ctx(org.ids.sellerA1), input);
    expect(result).toEqual({ saleId: input.requestId, replayed: false });

    expect(await saleRow(result.saleId)).toMatchObject({
      leadId,
      sellerId: org.ids.sellerA1,
      teamId: org.ids.teamA,
      supervisorId: org.ids.supA,
      saleDate: today(),
        paymentMethod: "PIX",
      installmentCount: null,
      status: "ACTIVE",
      createdBy: org.ids.sellerA1,
    });
    expect(await itemsOf(result.saleId)).toMatchObject([
      { courseId: course, costSnapshotCents: 40_000, commissionSnapshotCents: BUSINESS_RULES.commissionPerItemCents, removedAt: null },
    ]);
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED", ownerId: org.ids.sellerA1, stageDueAt: null, status: "ACTIVE" });
    expect(await cyclesOf(leadId)).toMatchObject([{ number: 1, endReason: "WON", endedBy: org.ids.sellerA1 }]);

    const events = await leadEventsOf(leadId);
    expect(events.at(-1)).toMatchObject({
      type: "SALE_CREATED",
      saleId: result.saleId,
      stage: "CLOSED",
      fromStage: "NEW",
      ownerId: org.ids.sellerA1,
      fromOwnerId: null,
      teamId: org.ids.teamA,
      supervisorId: org.ids.supA,
    });
    const audit = await saleEventsOf(result.saleId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ type: "CREATED", actorId: org.ids.sellerA1, reason: null });
    expect(audit[0].metadata).toMatchObject({ sale: { sellerId: org.ids.sellerA1, totalCents: 150_000, status: "ACTIVE" } });
  });

  it("cartão exige a quantidade de parcelas (sem máximo de negócio); Pix não aceita parcelas", async () => {
    const leadId = await newLead();
    const seller = await ctx(org.ids.sellerA1);
    await expectValidation(createSale(seller, saleInput(leadId, course, { paymentMethod: "CARD" })), "Informe a quantidade de parcelas do cartão.");
    await expectValidation(createSale(seller, saleInput(leadId, course, { installmentCount: 3 })), "Pix é à vista: não informe parcelas.");
    await expectValidation(createSale(seller, saleInput(leadId, course, { paymentMethod: "CARD", installmentCount: 0 })), "Informe ao menos 1 parcela.");

    const { saleId } = await createSale(seller, saleInput(leadId, course, { paymentMethod: "CARD", installmentCount: 48 }));
    expect(await saleRow(saleId)).toMatchObject({ paymentMethod: "CARD", installmentCount: 48 });
  });

  it("preço de curso zero ou negativo é recusado e nada é gravado; total enviado pelo cliente é recusado", async () => {
    const leadId = await newLead();
    const before = await leadRow(leadId);
    for (const priceCents of [0, -100]) {
      const input = saleInput(leadId, course, { items: [{ courseId: course, priceCents: 50_000 }, { courseId: course2, priceCents }] });
      await expectValidation(createSale(await ctx(org.ids.sellerA1), input), "O preço de cada curso deve ser maior que zero.");
      await expectNothingWritten(leadId, input.requestId as string, before);
    }
    const withTotal = saleInput(leadId, course, { totalCents: 1 });
    await expect(createSale(await ctx(org.ids.sellerA1), withTotal)).rejects.toBeInstanceOf(ValidationError);
    await expectNothingWritten(leadId, withTotal.requestId as string, before);
  });

  it("o mesmo curso pode repetir: cada ocorrência é um item com seu snapshot", async () => {
    const leadId = await newLead();
    const { saleId } = await createSale(
      await ctx(org.ids.sellerA1),
      saleInput(leadId, course, { items: [{ courseId: course, priceCents: 150_000 }, { courseId: course, priceCents: 150_000 }, { courseId: course2, priceCents: 150_000 }] }),
    );
    const items = await itemsOf(saleId);
    expect(items.map((i) => i.courseId).sort()).toEqual([course, course, course2].sort());
    expect(items.map((i) => i.costSnapshotCents).sort()).toEqual([40_000, 40_000, 55_000]);
  });

  it("várias vendas válidas no mesmo lead: a anterior fica intacta; o ciclo é encerrado uma vez só", async () => {
    const leadId = await newLead();
    const seller = await ctx(org.ids.sellerA1);
    const first = await createSale(seller, saleInput(leadId, course));
    const firstBefore = await saleRow(first.saleId);
    const second = await createSale(seller, saleInput(leadId, course2, { items: [{ courseId: course2, priceCents: 90_000 }] }));

    expect(await saleRow(first.saleId)).toEqual(firstBefore);
    expect(await saleRow(second.saleId)).toMatchObject({ status: "ACTIVE", totalCents: 90_000 });
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED" });
    expect(await cyclesOf(leadId)).toMatchObject([{ number: 1, endReason: "WON" }]);
    const saleCreated = (await leadEventsOf(leadId)).filter((e) => e.type === "SALE_CREATED");
    expect(saleCreated.map((e) => [e.saleId, e.fromStage])).toEqual([
      [first.saleId, "NEW"],
      [second.saleId, null],
    ]);
  });

  it("curso inativo ou inexistente é recusado; nada é gravado", async () => {
    const inactive = await insertCourseWithCost(handle, "Curso Encerrado", 10_000, false);
    const leadId = await newLead();
    const before = await leadRow(leadId);
    for (const courseId of [inactive, "00000000-0000-4000-8000-00000000c0de"]) {
      const input = saleInput(leadId, courseId);
      await expectValidation(createSale(await ctx(org.ids.sellerA1), input), COURSE_NOT_AVAILABLE);
      await expectNothingWritten(leadId, input.requestId as string, before);
    }
  });

  it("curso sem custo de bolsa cadastrado é recusado", async () => {
    const [noCost] = await handle.db
      .insert((await import("@/server/db/schema")).courses)
      .values({ name: "Curso Sem Custo", institutionName: "Faculdade Teste" })
      .returning();
    const leadId = await newLead();
    const error = await createSale(await ctx(org.ids.sellerA1), saleInput(leadId, noCost.id)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain("Curso Sem Custo");
    expect((error as ValidationError).message).not.toMatch(/\d{3}/);
  });

  it("snapshots: mudar o custo do curso depois não altera vendas antigas", async () => {
    const own = await insertCourseWithCost(handle, "Curso Reajustado", 30_000);
    const seller = await ctx(org.ids.sellerA1);
    const old = await createSale(seller, saleInput(await newLead(), own));
    await updateCourse(await ctx(org.ids.admin), own, { scholarshipCostCents: 45_000 });
    const recent = await createSale(seller, saleInput(await newLead(), own));

    expect((await itemsOf(old.saleId))[0].costSnapshotCents).toBe(30_000);
    expect((await itemsOf(recent.saleId))[0].costSnapshotCents).toBe(45_000);
  });

  it("lead com Follow-up 3 vencido pode receber venda (C37); o histórico é preservado", async () => {
    const leadId = await newLead();
    await setLeadStage(handle, leadId, "FOLLOW_UP_3", -1);
    const eventsBefore = await leadEventsOf(leadId);
    await createSale(await ctx(org.ids.sellerA1), saleInput(leadId, course));
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED", stageDueAt: null });
    const events = await leadEventsOf(leadId);
    expect(events.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    expect(events.at(-1)).toMatchObject({ type: "SALE_CREATED", fromStage: "FOLLOW_UP_3" });
  });

  it("negociação vencida (deste e de outro lead) não impede a venda (C37)", async () => {
    // Vendedor próprio: a negociação vencida que sobra bloquearia os cadastros dele (C34).
    const seller = await insertUser(handle, { name: "Vendedor Negociação", role: "SELLER", teamId: org.ids.teamA });
    const other = await newLead(seller);
    const leadId = await newLead(seller);
    await setLeadStage(handle, other, "NEGOTIATION", -1);
    await setLeadStage(handle, leadId, "NEGOTIATION", -1);
    await createSale(await ctx(seller), saleInput(leadId, course));
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED" });
    expect(await leadRow(other)).toMatchObject({ stage: "NEGOTIATION" });
  });

  it("lead na Lixeira: recusado para o supervisor; fora do escopo para o vendedor", async () => {
    const leadId = await newLead();
    await trashLead(await ctx(org.ids.supA), leadId);
    const before = await leadRow(leadId);
    const input = saleInput(leadId, course, { sellerId: org.ids.sellerA1 });
    await expectValidation(createSale(await ctx(org.ids.supA), input), LEAD_IN_TRASH);
    await expectNothingWritten(leadId, input.requestId as string, before);
    await expect(createSale(await ctx(org.ids.sellerA1), saleInput(leadId, course))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("vendedor inativo não pode ser o responsável", async () => {
    const inactive = await insertUser(handle, { name: "Vendedor Inativo", role: "SELLER", teamId: org.ids.teamA, active: false });
    const leadId = await newLead();
    await expectValidation(createSale(await ctx(org.ids.supA), saleInput(leadId, course, { sellerId: inactive })), SELLER_NOT_ACTIVE);
  });

  it("vendedor de equipe inativa não pode ser o responsável (C38), nem por ele mesmo", async () => {
    const supervisor = await insertUser(handle, { name: "Sup Equipe Fechada", role: "SUPERVISOR" });
    const [team] = await handle.db.insert(teams).values({ name: "Equipe Fechada Vendas", supervisorId: supervisor }).returning();
    const legacy = await insertUser(handle, { name: "Vendedor Legado", role: "SELLER", teamId: team.id });
    const ownLead = await newLead(legacy);
    await handle.db.update(teams).set({ active: false }).where(eq(teams.id, team.id));

    await expectValidation(createSale(await ctx(org.ids.admin), saleInput(await newLead(), course, { sellerId: legacy })), SELLER_TEAM_INACTIVE);
    await expectValidation(createSale(await ctx(legacy), saleInput(ownLead, course)), SELLER_TEAM_INACTIVE);
    expect(await leadRow(ownLead)).toMatchObject({ stage: "NEW", ownerId: legacy });
  });
});

describe("autorização e escolha do responsável", () => {
  it("SELLER atribui a um colega ativo da própria equipe: o lead passa para ele", async () => {
    const leadId = await newLead(org.ids.sellerA1);
    const { saleId } = await createSale(await ctx(org.ids.sellerA1), saleInput(leadId, course, { sellerId: org.ids.sellerA2 }));
    expect(await saleRow(saleId)).toMatchObject({ sellerId: org.ids.sellerA2, teamId: org.ids.teamA, createdBy: org.ids.sellerA1 });
    expect(await leadRow(leadId)).toMatchObject({ ownerId: org.ids.sellerA2, stage: "CLOSED" });
    expect((await leadEventsOf(leadId)).at(-1)).toMatchObject({ ownerId: org.ids.sellerA2, fromOwnerId: org.ids.sellerA1 });
    // A venda e o lead saíram do escopo de quem registrou.
    await expect(getSale(await ctx(org.ids.sellerA1), saleId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getSale(await ctx(org.ids.sellerA2), saleId)).id).toBe(saleId);
  });

  it("SELLER não atribui a vendedor de outra equipe", async () => {
    const leadId = await newLead();
    const before = await leadRow(leadId);
    const input = saleInput(leadId, course, { sellerId: org.ids.sellerB1 });
    await expectValidation(createSale(await ctx(org.ids.sellerA1), input), SELLER_OUTSIDE_TEAM);
    await expectNothingWritten(leadId, input.requestId as string, before);
  });

  it("SUPERVISOR escolhe qualquer vendedor ativo: venda e lead vão para a equipe ATUAL dele, com o supervisor dela", async () => {
    const leadId = await newLead(org.ids.sellerA1);
    const { saleId } = await createSale(await ctx(org.ids.supA), saleInput(leadId, course, { sellerId: org.ids.sellerB1 }));
    expect(await saleRow(saleId)).toMatchObject({ sellerId: org.ids.sellerB1, teamId: org.ids.teamB, supervisorId: org.ids.supB, createdBy: org.ids.supA });
    expect(await leadRow(leadId)).toMatchObject({ ownerId: org.ids.sellerB1, teamId: org.ids.teamB });
    expect((await leadEventsOf(leadId)).at(-1)).toMatchObject({
      teamId: org.ids.teamB,
      fromTeamId: org.ids.teamA,
      supervisorId: org.ids.supB,
      fromSupervisorId: org.ids.supA,
    });
  });

  it("SUPERVISOR e ADMIN precisam escolher o vendedor; só o ADMIN informa a data", async () => {
    const leadId = await newLead();
    await expectValidation(createSale(await ctx(org.ids.supA), saleInput(leadId, course)), SELLER_REQUIRED);
    await expect(
      createSale(await ctx(org.ids.supA), saleInput(leadId, course, { sellerId: org.ids.sellerA1, saleDate: "2026-01-15" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createSale(await ctx(org.ids.sellerA1), saleInput(leadId, course, { saleDate: "2026-01-15" }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const { saleId } = await createSale(await ctx(org.ids.admin), saleInput(leadId, course, { sellerId: org.ids.sellerA2, saleDate: "2026-01-15" }));
    expect(await saleRow(saleId)).toMatchObject({ sellerId: org.ids.sellerA2, saleDate: "2026-01-15", createdBy: org.ids.admin });
  });

  it("lead fora do escopo → NotFound, para vendedor e supervisor", async () => {
    const leadId = await newLead(org.ids.sellerA1);
    await expect(createSale(await ctx(org.ids.sellerB1), saleInput(leadId, course))).rejects.toBeInstanceOf(NotFoundError);
    await expect(createSale(await ctx(org.ids.supB), saleInput(leadId, course, { sellerId: org.ids.sellerB1 }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("ator desativado depois de carregar a sessão → sessão encerrada, nada gravado", async () => {
    const admin2 = await insertUser(handle, { name: "Admin Desligado", role: "ADMIN" });
    const stale = await ctx(admin2);
    await handle.db.update(users).set({ active: false }).where(eq(users.id, admin2));
    const leadId = await newLead();
    const before = await leadRow(leadId);
    const input = saleInput(leadId, course, { sellerId: org.ids.sellerA1 });
    await expect(createSale(stale, input)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expectNothingWritten(leadId, input.requestId as string, before);
  });

  it("campos privilegiados no payload são recusados (custo, comissão, equipe, supervisor, status)", async () => {
    const leadId = await newLead();
    for (const extra of [{ teamId: org.ids.teamB }, { supervisorId: org.ids.supB }, { status: "REVERSED" }, { createdBy: org.ids.admin }]) {
      await expect(createSale(await ctx(org.ids.sellerA1), saleInput(leadId, course, extra))).rejects.toBeInstanceOf(ValidationError);
    }
    const withCost = saleInput(leadId, course, { items: [{ courseId: course, costSnapshotCents: 1, commissionSnapshotCents: 999_999 }] });
    await expect(createSale(await ctx(org.ids.sellerA1), withCost)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("consultas e informações sensíveis", () => {
  it("SELLER vê só as próprias vendas; filtros não ampliam o escopo", async () => {
    const mine = await createSale(await ctx(org.ids.sellerB1), saleInput(await newLead(org.ids.sellerB1), course));
    const seller = await ctx(org.ids.sellerB1);
    const listed = await listSales(seller, { pageSize: 100 });
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items.every((s) => s.sellerId === org.ids.sellerB1)).toBe(true);
    expect(listed.items.some((s) => s.id === mine.saleId)).toBe(true);
    expect((await listSales(seller, { sellerId: org.ids.sellerA1 })).total).toBe(0);
    expect((await listSales(seller, { teamId: org.ids.teamA })).total).toBe(0);
  });

  it("SUPERVISOR vê vendas dos vendedores que estão HOJE na equipe dele (não a equipe histórica)", async () => {
    const mover = await insertUser(handle, { name: "Vendedor Que Muda", role: "SELLER", teamId: org.ids.teamA });
    const { saleId } = await createSale(await ctx(mover), saleInput(await newLead(mover), course));
    expect((await getSale(await ctx(org.ids.supA), saleId)).teamId).toBe(org.ids.teamA);

    await changeSellerTeam(await ctx(org.ids.admin), mover, { teamId: org.ids.teamB });

    await expect(getSale(await ctx(org.ids.supA), saleId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listSales(await ctx(org.ids.supA), { sellerId: mover })).total).toBe(0);
    const forB = await getSale(await ctx(org.ids.supB), saleId);
    expect(forB.teamId).toBe(org.ids.teamA); // atribuição histórica preservada
    expect((await listSales(await ctx(org.ids.supB), { sellerId: mover })).items.map((s) => s.id)).toEqual([saleId]);
  });

  it("ADMIN vê todas; paginação e contagem usam as mesmas condições", async () => {
    const all = await listSales(await ctx(org.ids.admin), { pageSize: 25 });
    const [{ total }] = await handle.db.select({ total: (await import("drizzle-orm")).count() }).from(sales);
    expect(all.total).toBe(total);
    expect(all.items.length).toBe(Math.min(25, total));
  });

  it("custos de bolsa nunca saem para vendedor e supervisor (detalhe, histórico e linha do tempo do lead)", async () => {
    const leadId = await newLead(org.ids.sellerA1);
    const { saleId } = await createSale(await ctx(org.ids.sellerA1), saleInput(leadId, course));
    for (const userId of [org.ids.sellerA1, org.ids.supA]) {
      const viewer = await ctx(userId);
      const payload = JSON.stringify([
        await getSale(viewer, saleId),
        await getSaleHistory(viewer, saleId),
        await listSales(viewer, { leadId }),
        await getLeadTimeline(viewer, leadId),
      ]);
      expect(payload).not.toMatch(/cost/i);
      expect(payload).not.toContain("40000");
      expect(payload).not.toMatch(/txid|tx_base|txBase/i);
      await expect(getSaleWithCost(viewer, saleId)).rejects.toBeInstanceOf(ForbiddenError);
    }
    const admin = await ctx(org.ids.admin);
    const withCost = await getSaleWithCost(admin, saleId);
    expect(withCost.items.map((i) => i.costSnapshotCents)).toEqual([40_000]);
    expect(withCost.costTotalCents).toBe(40_000);
    expect(JSON.stringify(await getSaleHistory(admin, saleId))).toContain("costSnapshotCents");
  });

  it("venda inexistente ou fora do escopo → NotFound", async () => {
    const { saleId } = await createSale(await ctx(org.ids.sellerA1), saleInput(await newLead(org.ids.sellerA1), course));
    await expect(getSale(await ctx(org.ids.sellerB1), saleId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSale(await ctx(org.ids.supB), saleId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSaleHistory(await ctx(org.ids.supB), saleId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSale(await ctx(org.ids.admin), "00000000-0000-4000-8000-0000000000aa")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("idempotência", () => {
  it("a mesma solicitação repetida (resposta perdida) devolve a mesma venda sem gravar de novo", async () => {
    const leadId = await newLead();
    const input = saleInput(leadId, course, { items: [{ courseId: course, priceCents: 150_000 }, { courseId: course2, priceCents: 150_000 }] });
    const seller = await ctx(org.ids.sellerA1);
    expect(await createSale(seller, input)).toEqual({ saleId: input.requestId, replayed: false });
    // Mesmos dados, cursos em outra ordem.
    const again = { ...input, items: [{ courseId: course2, priceCents: 150_000 }, { courseId: course, priceCents: 150_000 }] };
    expect(await createSale(seller, again)).toEqual({ saleId: input.requestId, replayed: true });

    expect(await handle.db.select().from(sales).where(eq(sales.leadId, leadId))).toHaveLength(1);
    expect(await saleEventsOf(input.requestId as string)).toHaveLength(1);
    expect((await leadEventsOf(leadId)).filter((e) => e.type === "SALE_CREATED")).toHaveLength(1);
  });

  it("repetição depois de o lead sair do escopo de quem registrou continua sendo reconhecida", async () => {
    const leadId = await newLead(org.ids.sellerA1);
    const input = saleInput(leadId, course, { sellerId: org.ids.sellerA2 });
    await createSale(await ctx(org.ids.sellerA1), input);
    expect(await createSale(await ctx(org.ids.sellerA1), input)).toEqual({ saleId: input.requestId, replayed: true });
  });

  it("o mesmo identificador com outros dados, ou por outro usuário, é recusado sem gravar nada", async () => {
    const leadId = await newLead();
    const input = saleInput(leadId, course);
    await createSale(await ctx(org.ids.sellerA1), input);
    const variants = [
      { ...input, items: [{ courseId: course, priceCents: 1 }] },
      { ...input, paymentMethod: "CARD", installmentCount: 2 },
      { ...input, items: [{ courseId: course2, priceCents: 150_000 }] },
      { ...input, leadId: await newLead() },
    ];
    for (const variant of variants) {
      const error = await createSale(await ctx(org.ids.sellerA1), variant).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).message).toBe(REQUEST_ID_REUSED);
    }
    await expect(createSale(await ctx(org.ids.admin), { ...input, sellerId: org.ids.sellerA1 })).rejects.toBeInstanceOf(ConflictError);
    expect(await handle.db.select().from(sales).where(eq(sales.id, input.requestId as string))).toHaveLength(1);
    expect(await handle.db.select().from(saleEvents).where(and(eq(saleEvents.saleId, input.requestId as string)))).toHaveLength(1);
  });
});
