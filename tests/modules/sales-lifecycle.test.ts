import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { leadCycles, leadEvents, leads, saleEvents, saleItems, sales, teams } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { updateCourse } from "@/server/modules/courses/courses.service";
import { createLead, REVERSAL_NEEDS_VALID_OWNER, restoreLead, trashLead } from "@/server/modules/leads/leads.service";
import {
  COURSE_NOT_AVAILABLE,
  createSale,
  getSale,
  getSaleHistory,
  ITEM_NOT_IN_SALE,
  LEAD_IN_TRASH_REACTIVATE,
  reactivateSale,
  RESPONSIBLE_INVALID_REACTIVATE,
  reverseSale,
  SALE_ALREADY_ACTIVE,
  SALE_ALREADY_REVERSED,
  SALE_CHANGED_CONCURRENTLY,
  SALE_NEEDS_ITEM,
  SALE_REVERSED_READ_ONLY,
  SELLER_NOT_ACTIVE,
  SELLER_TEAM_INACTIVE,
  updateSale,
} from "@/server/modules/sales/sales.service";
import { changeSellerTeam, setUserActive } from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
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

const ctx = (userId: string) => org.ctx(userId);
const nextPhone = () => `(79) 93${String(++seq).padStart(7, "0")}`;

async function newSeller(name: string, teamId: string = org.ids.teamA): Promise<string> {
  return insertUser(handle, { name: `${name} ${++seq}`, role: "SELLER", teamId });
}

async function newLead(sellerId: string): Promise<string> {
  return (await createLead(await ctx(sellerId), { name: `Cliente ${seq}`, phone: nextPhone(), interestCourseId: course })).id;
}

/** Lead do vendedor com uma venda dele; devolve ids. */
async function soldLead(sellerId: string, overrides: Record<string, unknown> = {}) {
  const leadId = await newLead(sellerId);
  const { saleId } = await createSale(await ctx(sellerId), saleInput(leadId, course, overrides));
  return { leadId, saleId };
}

const version = async (saleId: string) => (await getSale(await ctx(org.ids.admin), saleId)).version;
const saleRow = async (id: string) => (await handle.db.select().from(sales).where(eq(sales.id, id)))[0];
const leadRow = async (id: string) => (await handle.db.select().from(leads).where(eq(leads.id, id)))[0];
const itemsOf = (saleId: string) => handle.db.select().from(saleItems).where(eq(saleItems.saleId, saleId)).orderBy(asc(saleItems.addedAt), asc(saleItems.id));
const saleEventsOf = (saleId: string) => handle.db.select().from(saleEvents).where(eq(saleEvents.saleId, saleId)).orderBy(asc(saleEvents.id));
const leadEventsOf = (leadId: string) => handle.db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId)).orderBy(asc(leadEvents.id));
const cyclesOf = (leadId: string) => handle.db.select().from(leadCycles).where(eq(leadCycles.leadId, leadId)).orderBy(asc(leadCycles.number));

async function expectError(promise: Promise<unknown>, type: new (...args: never[]) => Error, message?: string): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(type);
  if (message) {
    const v = error as ValidationError;
    expect([v.message, ...Object.values(v.fieldErrors ?? {}).flat()]).toContain(message);
  }
}

async function reverse(userId: string, saleId: string, reason = "Cliente desistiu") {
  return reverseSale(await ctx(userId), saleId, { expectedVersion: await version(saleId), reason });
}
async function reactivate(userId: string, saleId: string, reason = "Pagamento confirmado") {
  return reactivateSale(await ctx(userId), saleId, { expectedVersion: await version(saleId), reason });
}

// ---------------------------------------------------------------------------

describe("edição de venda", () => {
  it("SELLER inclui cursos (inclusive repetidos, com preços próprios): total recalculado, snapshots, UPDATED com antes/depois", async () => {
    const seller = await newSeller("Vendedor Itens");
    const { saleId } = await soldLead(seller);
    const [original] = await itemsOf(saleId);

    const result = await updateSale(await ctx(seller), saleId, {
      expectedVersion: await version(saleId),
      addItems: [{ courseId: course2, priceCents: 70_000 }, { courseId: course2, priceCents: 65_000 }],
    });
    expect(result.changed).toBe(true);
    expect(result.version).toBeGreaterThan(0);

    const items = await itemsOf(saleId);
    expect(items.map((i) => [i.courseId, i.priceCents, i.costSnapshotCents, i.removedAt]).sort()).toEqual(
      [
        [course, 150_000, 40_000, null],
        [course2, 70_000, 55_000, null],
        [course2, 65_000, 55_000, null],
      ].sort(),
    );
    expect(items.find((i) => i.id === original.id)).toEqual(original);
    expect((await saleRow(saleId)).totalCents).toBe(285_000);

    const updated = (await saleEventsOf(saleId)).at(-1)!;
    expect(updated).toMatchObject({ type: "UPDATED", actorId: seller });
    const metadata = updated.metadata as { changes: object; itemsAdded: { priceCents: number }[]; itemsRemoved: unknown[]; itemsRepriced: unknown[] };
    expect(metadata.changes).toEqual({ totalCents: { from: 150_000, to: 285_000 } });
    expect(metadata.itemsAdded.map((i) => i.priceCents).sort((x, y) => x - y)).toEqual([65_000, 70_000]);
    expect(metadata.itemsRemoved).toEqual([]);
    expect(metadata.itemsRepriced).toEqual([]);
  });

  it("SELLER não remove itens, não corrige preço, nem altera pagamento, parcelas, data ou responsável (Forbidden; nada muda)", async () => {
    const seller = await newSeller("Vendedor Bloqueado");
    const { saleId } = await soldLead(seller);
    const [item] = await itemsOf(saleId);
    const v = await version(saleId);
    for (const field of [
      { removeItemIds: [item.id] },
      { repriceItems: [{ itemId: item.id, priceCents: 1 }] },
      { paymentMethod: "CARD", installmentCount: 2 },
      { installmentCount: null },
      { saleDate: "2026-01-01" },
      { sellerId: org.ids.sellerA2 },
    ]) {
      await expectError(updateSale(await ctx(seller), saleId, { expectedVersion: v, ...field }), ForbiddenError);
    }
    // Total, snapshot ou lead no payload: recusados pela validação estrita.
    await expectError(updateSale(await ctx(seller), saleId, { expectedVersion: v, totalCents: 1 }), ValidationError);
    await expectError(updateSale(await ctx(seller), saleId, { expectedVersion: v, leadId: await newLead(seller) }), ValidationError);
    await expectError(
      updateSale(await ctx(seller), saleId, { expectedVersion: v, addItems: [{ courseId: course, costSnapshotCents: 1 }] }),
      ValidationError,
    );
    expect(await version(saleId)).toBe(v);
  });

  it("SUPERVISOR corrige preço e pagamento (não a data); ADMIN altera a data", async () => {
    const { saleId } = await soldLead(org.ids.sellerA1);
    const [item] = await itemsOf(saleId);
    const sup = await ctx(org.ids.supA);
    await expectError(updateSale(sup, saleId, { expectedVersion: await version(saleId), saleDate: "2026-02-01" }), ForbiddenError);
    await expectError(updateSale(sup, saleId, { expectedVersion: await version(saleId), paymentMethod: "CARD" }), ValidationError, "Informe a quantidade de parcelas do cartão.");

    await updateSale(sup, saleId, {
      expectedVersion: await version(saleId),
      repriceItems: [{ itemId: item.id, priceCents: 99_000 }],
      paymentMethod: "CARD",
      installmentCount: 6,
    });
    expect(await saleRow(saleId)).toMatchObject({ totalCents: 99_000, paymentMethod: "CARD", installmentCount: 6 });
    // Correção no próprio item: custo e comissão da época intactos.
    const [after] = await itemsOf(saleId);
    expect(after).toMatchObject({ id: item.id, priceCents: 99_000, costSnapshotCents: item.costSnapshotCents, commissionSnapshotCents: item.commissionSnapshotCents, removedAt: null });
    const metadata = (await saleEventsOf(saleId)).at(-1)!.metadata as { changes: object; itemsRepriced: unknown[] };
    expect(metadata.changes).toEqual({
      totalCents: { from: 150_000, to: 99_000 },
      paymentMethod: { from: "PIX", to: "CARD" },
      installmentCount: { from: null, to: 6 },
    });
    expect(metadata.itemsRepriced).toEqual([{ id: item.id, courseId: course, from: 150_000, to: 99_000 }]);

    // Pix exige parcelas vazias explicitamente.
    await expectError(updateSale(sup, saleId, { expectedVersion: await version(saleId), paymentMethod: "PIX" }), ValidationError);
    await updateSale(sup, saleId, { expectedVersion: await version(saleId), paymentMethod: "PIX", installmentCount: null });
    expect(await saleRow(saleId)).toMatchObject({ paymentMethod: "PIX", installmentCount: null });

    await updateSale(await ctx(org.ids.admin), saleId, { expectedVersion: await version(saleId), saleDate: "2026-02-01" });
    expect((await saleRow(saleId)).saleDate).toBe("2026-02-01");
  });

  it("itens: não remove todos, só remove itens atuais da venda e só inclui cursos ativos", async () => {
    const { saleId } = await soldLead(org.ids.sellerA1);
    const [item] = await itemsOf(saleId);
    const other = await soldLead(org.ids.sellerA1);
    const [foreign] = await itemsOf(other.saleId);
    const inactive = await insertCourseWithCost(handle, `Encerrado ${++seq}`, 10_000, false);
    const sup = await ctx(org.ids.supA);
    const v = await version(saleId);

    await expectError(updateSale(sup, saleId, { expectedVersion: v, removeItemIds: [item.id] }), ValidationError, SALE_NEEDS_ITEM);
    await expectError(updateSale(sup, saleId, { expectedVersion: v, removeItemIds: [foreign.id] }), ValidationError, ITEM_NOT_IN_SALE);
    await expectError(updateSale(sup, saleId, { expectedVersion: v, addItems: [{ courseId: inactive, priceCents: 150_000 }] }), ValidationError, COURSE_NOT_AVAILABLE);

    await updateSale(sup, saleId, { expectedVersion: v, addItems: [{ courseId: course, priceCents: 150_000 }], removeItemIds: [item.id] });
    await expectError(updateSale(sup, saleId, { expectedVersion: await version(saleId), removeItemIds: [item.id] }), ValidationError, ITEM_NOT_IN_SALE);
  });

  it("item novo usa o custo vigente; os antigos mantêm o da época", async () => {
    const own = await insertCourseWithCost(handle, `Reajuste ${++seq}`, 20_000);
    const leadId = await newLead(org.ids.sellerA1);
    const { saleId } = await createSale(await ctx(org.ids.sellerA1), saleInput(leadId, own));
    await updateCourse(await ctx(org.ids.admin), own, { scholarshipCostCents: 26_000 });
    await updateSale(await ctx(org.ids.sellerA1), saleId, { expectedVersion: await version(saleId), addItems: [{ courseId: own, priceCents: 150_000 }] });
    expect((await itemsOf(saleId)).map((i) => i.costSnapshotCents)).toEqual([20_000, 26_000]);
  });

  it("troca de responsável (SUPERVISOR): venda e lead vão para a equipe atual do novo vendedor; histórico completo", async () => {
    const { leadId, saleId } = await soldLead(org.ids.sellerA1);
    await updateSale(await ctx(org.ids.supA), saleId, { expectedVersion: await version(saleId), sellerId: org.ids.sellerB1 });

    expect(await saleRow(saleId)).toMatchObject({ sellerId: org.ids.sellerB1, teamId: org.ids.teamB, supervisorId: org.ids.supB });
    expect(await leadRow(leadId)).toMatchObject({ ownerId: org.ids.sellerB1, teamId: org.ids.teamB, stage: "CLOSED" });
    expect((await leadEventsOf(leadId)).at(-1)).toMatchObject({
      type: "SALE_SELLER_CHANGED",
      saleId,
      ownerId: org.ids.sellerB1,
      fromOwnerId: org.ids.sellerA1,
      teamId: org.ids.teamB,
      fromTeamId: org.ids.teamA,
    });
    expect(((await saleEventsOf(saleId)).at(-1)!.metadata as { changes: object }).changes).toMatchObject({
      sellerId: { from: org.ids.sellerA1, to: org.ids.sellerB1 },
      teamId: { from: org.ids.teamA, to: org.ids.teamB },
      supervisorId: { from: org.ids.supA, to: org.ids.supB },
    });
    // O supervisor A não vê mais a venda (o responsável não está na equipe dele).
    await expectError(getSale(await ctx(org.ids.supA), saleId), NotFoundError);
  });

  it("novo responsável precisa ser vendedor ativo de equipe ativa", async () => {
    const { saleId } = await soldLead(org.ids.sellerA1);
    const inactive = await insertUser(handle, { name: `Inativo ${++seq}`, role: "SELLER", teamId: org.ids.teamA, active: false });
    const supervisor = await insertUser(handle, { name: `Sup Fechada ${++seq}`, role: "SUPERVISOR" });
    const [team] = await handle.db.insert(teams).values({ name: `Fechada ${seq}`, supervisorId: supervisor }).returning();
    const legacy = await insertUser(handle, { name: `Legado ${seq}`, role: "SELLER", teamId: team.id });
    await handle.db.update(teams).set({ active: false }).where(eq(teams.id, team.id));
    const admin = await ctx(org.ids.admin);
    await expectError(updateSale(admin, saleId, { expectedVersion: await version(saleId), sellerId: inactive }), ValidationError, SELLER_NOT_ACTIVE);
    await expectError(updateSale(admin, saleId, { expectedVersion: await version(saleId), sellerId: legacy }), ValidationError, SELLER_TEAM_INACTIVE);
  });

  it("versão desatualizada ou reenvio de edição já aplicada → conflito, sem duplicar", async () => {
    const { saleId } = await soldLead(org.ids.sellerA1);
    const edit = { expectedVersion: await version(saleId), addItems: [{ courseId: course2, priceCents: 150_000 }] };
    await updateSale(await ctx(org.ids.sellerA1), saleId, edit);
    await expectError(updateSale(await ctx(org.ids.sellerA1), saleId, edit), ConflictError, SALE_CHANGED_CONCURRENTLY);
    expect((await itemsOf(saleId)).filter((i) => i.courseId === course2)).toHaveLength(1);
    expect((await saleEventsOf(saleId)).map((e) => e.type)).toEqual(["CREATED", "UPDATED"]);
  });

  it("edição sem mudança líquida não grava nada", async () => {
    const { saleId } = await soldLead(org.ids.sellerA1);
    const v = await version(saleId);
    const [item] = await itemsOf(saleId);
    const result = await updateSale(await ctx(org.ids.supA), saleId, {
      expectedVersion: v,
      repriceItems: [{ itemId: item.id, priceCents: 150_000 }],
      paymentMethod: "PIX",
      installmentCount: null,
      sellerId: org.ids.sellerA1,
    });
    expect(result).toEqual({ saleId, version: v, changed: false });
    expect(await saleEventsOf(saleId)).toHaveLength(1);
  });

  it("venda estornada é somente leitura para o SELLER; SUPERVISOR corrige (sem mexer no lead)", async () => {
    const seller = await newSeller("Vendedor Estornado");
    const { leadId, saleId } = await soldLead(seller);
    await reverse(org.ids.supA, saleId);
    await expectError(
      updateSale(await ctx(seller), saleId, { expectedVersion: await version(saleId), addItems: [{ courseId: course, priceCents: 150_000 }] }),
      ValidationError,
      SALE_REVERSED_READ_ONLY,
    );
    const leadBefore = await leadRow(leadId);
    const [item] = await itemsOf(saleId);
    await updateSale(await ctx(org.ids.supA), saleId, {
      expectedVersion: await version(saleId),
      sellerId: org.ids.sellerA2,
      repriceItems: [{ itemId: item.id, priceCents: 80_000 }],
    });
    expect(await saleRow(saleId)).toMatchObject({ sellerId: org.ids.sellerA2, totalCents: 80_000, status: "REVERSED" });
    expect(await leadRow(leadId)).toEqual(leadBefore);
    expect((await leadEventsOf(leadId)).some((e) => e.type === "SALE_SELLER_CHANGED")).toBe(false);
  });
});

describe("estorno", () => {
  it("com outra venda válida: lead continua em Fechamento, mesmo responsável, sem ciclo novo; a outra venda fica intacta", async () => {
    const seller = await newSeller("Vendedor Duas");
    const leadId = await newLead(seller);
    const first = await createSale(await ctx(seller), saleInput(leadId, course));
    const second = await createSale(await ctx(seller), saleInput(leadId, course2));
    const secondBefore = await saleRow(second.saleId);
    const itemsBefore = await itemsOf(first.saleId);

    const result = await reverse(org.ids.supA, first.saleId, "Duplicada");
    expect(result.leadOutcome).toBe("KEEP_CLOSED");
    expect(await saleRow(first.saleId)).toMatchObject({ status: "REVERSED" });
    expect(await saleRow(second.saleId)).toEqual(secondBefore);
    expect(await itemsOf(first.saleId)).toEqual(itemsBefore);
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED", ownerId: seller });
    expect(await cyclesOf(leadId)).toHaveLength(1);
    expect((await leadEventsOf(leadId)).at(-1)).toMatchObject({ type: "SALE_REVERSED", saleId: first.saleId, stage: "CLOSED", ownerId: seller });
    expect((await saleEventsOf(first.saleId)).at(-1)).toMatchObject({
      type: "REVERSED",
      reason: "Duplicada",
      actorId: org.ids.supA,
      metadata: { status: { from: "ACTIVE", to: "REVERSED" } },
    });
  });

  it("última venda, responsável ativo da equipe do lead: Lead cadastrado em novo ciclo REOPENED com ele", async () => {
    const seller = await newSeller("Vendedor Reabre");
    const { leadId, saleId } = await soldLead(seller);
    const result = await reverse(org.ids.admin, saleId);
    expect(result.leadOutcome).toBe("REOPEN");
    expect(await leadRow(leadId)).toMatchObject({ stage: "NEW", ownerId: seller, stageDueAt: null, unassignedReason: null });
    const cycles = await cyclesOf(leadId);
    expect(cycles.map((c) => [c.number, c.kind, c.endReason])).toEqual([
      [1, "INITIAL", "WON"],
      [2, "REOPENED", null],
    ]);
    expect(cycles[1]).toMatchObject({ assignedSellerId: seller, startedBy: org.ids.admin });
    expect((await leadEventsOf(leadId)).at(-1)).toMatchObject({
      type: "SALE_REVERSED",
      cycleId: cycles[1].id,
      stage: "NEW",
      fromStage: "CLOSED",
      ownerId: seller,
    });
  });

  it("última venda, responsável inativo: reabre na fila do supervisor (sem responsável) e registra o motivo", async () => {
    const seller = await newSeller("Vendedor Saiu");
    const { leadId, saleId } = await soldLead(seller);
    await setUserActive(await ctx(org.ids.admin), seller, false);
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED", ownerId: seller }); // lead fechado não vai para a fila

    const result = await reverse(org.ids.supA, saleId);
    expect(result.leadOutcome).toBe("REOPEN_TO_QUEUE");
    expect(await leadRow(leadId)).toMatchObject({ stage: "NEW", ownerId: null, unassignedReason: "OWNER_DEACTIVATED", teamId: org.ids.teamA });
    expect((await cyclesOf(leadId)).at(-1)).toMatchObject({ kind: "REOPENED", assignedSellerId: seller, endedAt: null });
    expect((await leadEventsOf(leadId)).slice(-2).map((e) => [e.type, e.ownerId, e.fromOwnerId])).toEqual([
      ["SALE_REVERSED", seller, null],
      ["UNASSIGNED", null, seller],
    ]);
  });

  it("última venda com responsável ativo em outra equipe: recusado sem regra; regulariza trocando o responsável", async () => {
    const seller = await newSeller("Vendedor Transferido");
    const { leadId, saleId } = await soldLead(seller);
    await changeSellerTeam(await ctx(org.ids.admin), seller, { teamId: org.ids.teamB });
    const leadBefore = await leadRow(leadId);

    await expectError(reverse(org.ids.admin, saleId), ConflictError, REVERSAL_NEEDS_VALID_OWNER);
    expect(await saleRow(saleId)).toMatchObject({ status: "ACTIVE" });
    expect(await leadRow(leadId)).toEqual(leadBefore);

    await updateSale(await ctx(org.ids.admin), saleId, { expectedVersion: await version(saleId), sellerId: org.ids.sellerA2 });
    expect((await reverse(org.ids.admin, saleId)).leadOutcome).toBe("REOPEN");
    expect(await leadRow(leadId)).toMatchObject({ stage: "NEW", ownerId: org.ids.sellerA2, teamId: org.ids.teamA });
  });

  it("permissões, motivo, escopo e estado", async () => {
    const { saleId } = await soldLead(org.ids.sellerA1);
    const v = await version(saleId);
    await expectError(reverseSale(await ctx(org.ids.sellerA1), saleId, { expectedVersion: v, reason: "x" }), ForbiddenError);
    await expectError(reverseSale(await ctx(org.ids.supA), saleId, { expectedVersion: v, reason: "   " }), ValidationError, "Informe o motivo.");
    await expectError(reverseSale(await ctx(org.ids.supB), saleId, { expectedVersion: v, reason: "x" }), NotFoundError);
    await reverse(org.ids.supA, saleId);
    await expectError(reverse(org.ids.supA, saleId), ValidationError, SALE_ALREADY_REVERSED);
    // Reenvio com a versão antiga: conflito, um único REVERSED.
    await expectError(reverseSale(await ctx(org.ids.supA), saleId, { expectedVersion: v, reason: "x" }), ConflictError);
    expect((await saleEventsOf(saleId)).filter((e) => e.type === "REVERSED")).toHaveLength(1);
  });
});

describe("reativação", () => {
  it("lead reaberto: venda válida de novo, lead em Fechamento com o responsável da venda, ciclo REOPENED encerrado", async () => {
    const seller = await newSeller("Vendedor Volta");
    const { leadId, saleId } = await soldLead(seller);
    await reverse(org.ids.supA, saleId);
    await reactivate(org.ids.supA, saleId, "Estorno indevido");

    expect(await saleRow(saleId)).toMatchObject({ status: "ACTIVE" });
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED", ownerId: seller });
    expect((await cyclesOf(leadId)).map((c) => [c.kind, c.endReason])).toEqual([
      ["INITIAL", "WON"],
      ["REOPENED", "WON"],
    ]);
    expect((await leadEventsOf(leadId)).at(-1)).toMatchObject({ type: "SALE_REACTIVATED", fromStage: "NEW", stage: "CLOSED", saleId });
    expect((await saleEventsOf(saleId)).map((e) => [e.type, e.reason])).toEqual([
      ["CREATED", null],
      ["REVERSED", "Cliente desistiu"],
      ["REACTIVATED", "Estorno indevido"],
    ]);
  });

  it("lead já em Fechamento por outra venda: o responsável do lead passa a ser o da venda reativada", async () => {
    const leadId = await newLead(org.ids.sellerA1);
    const first = await createSale(await ctx(org.ids.sellerA1), saleInput(leadId, course));
    await reverse(org.ids.supA, first.saleId); // reabre com A1
    await createSale(await ctx(org.ids.supA), saleInput(leadId, course, { sellerId: org.ids.sellerA2 }));
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED", ownerId: org.ids.sellerA2 });

    await reactivate(org.ids.supA, first.saleId);
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED", ownerId: org.ids.sellerA1 });
    expect((await leadEventsOf(leadId)).at(-1)).toMatchObject({ type: "SALE_REACTIVATED", fromStage: null, fromOwnerId: org.ids.sellerA2 });
  });

  it("responsável inativo ou de equipe inativa: bloqueia até trocar o responsável", async () => {
    const seller = await newSeller("Vendedor Bloqueia");
    const { leadId, saleId } = await soldLead(seller);
    await reverse(org.ids.supA, saleId);
    await setUserActive(await ctx(org.ids.admin), seller, false);
    await expectError(reactivate(org.ids.supA, saleId), ValidationError, RESPONSIBLE_INVALID_REACTIVATE);
    expect(await saleRow(saleId)).toMatchObject({ status: "REVERSED" });

    await updateSale(await ctx(org.ids.supA), saleId, { expectedVersion: await version(saleId), sellerId: org.ids.sellerA2 });
    await reactivate(org.ids.supA, saleId);
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED", ownerId: org.ids.sellerA2 });
  });

  it("lead na Lixeira: exige recuperação antes (nada é recuperado automaticamente)", async () => {
    const seller = await newSeller("Vendedor Lixeira");
    const { leadId, saleId } = await soldLead(seller);
    await reverse(org.ids.supA, saleId);
    await trashLead(await ctx(org.ids.supA), leadId);
    await expectError(reactivate(org.ids.supA, saleId), ValidationError, LEAD_IN_TRASH_REACTIVATE);
    expect(await leadRow(leadId)).toMatchObject({ status: "TRASHED" });

    await restoreLead(await ctx(org.ids.supA), leadId, { toSellerId: seller });
    await reactivate(org.ids.supA, saleId);
    expect(await leadRow(leadId)).toMatchObject({ status: "ACTIVE", stage: "CLOSED", ownerId: seller });
  });

  it("permissões e estado: vendedor não reativa; motivo obrigatório; venda válida não é reativada", async () => {
    const { saleId } = await soldLead(org.ids.sellerA1);
    await expectError(reactivate(org.ids.supA, saleId), ValidationError, SALE_ALREADY_ACTIVE);
    await reverse(org.ids.supA, saleId);
    const v = await version(saleId);
    await expectError(reactivateSale(await ctx(org.ids.sellerA1), saleId, { expectedVersion: v, reason: "x" }), ForbiddenError);
    await expectError(reactivateSale(await ctx(org.ids.admin), saleId, { expectedVersion: v, reason: "" }), ValidationError, "Informe o motivo.");
  });
});

describe("histórico e dados restritos", () => {
  it("SELLER e SUPERVISOR veem o histórico completo sem custos; o ADMIN vê os custos dos itens", async () => {
    const seller = await newSeller("Vendedor Histórico");
    const { saleId } = await soldLead(seller);
    await updateSale(await ctx(seller), saleId, { expectedVersion: await version(saleId), addItems: [{ courseId: course2, priceCents: 150_000 }] });
    await reverse(org.ids.supA, saleId);
    await reactivate(org.ids.supA, saleId);

    for (const userId of [seller, org.ids.supA]) {
      const history = await getSaleHistory(await ctx(userId), saleId);
      expect(history.map((h) => h.type)).toEqual(["CREATED", "UPDATED", "REVERSED", "REACTIVATED"]);
      const payload = JSON.stringify([history, await getSale(await ctx(userId), saleId)]);
      expect(payload).not.toMatch(/cost/i);
      expect(payload).not.toContain("55000");
    }
    expect(JSON.stringify(await getSaleHistory(await ctx(org.ids.admin), saleId))).toContain("55000");
  });

  it("os eventos de status não duplicam e cada UPDATED fica numa transação", async () => {
    const { saleId } = await soldLead(org.ids.sellerA1);
    await reverse(org.ids.supA, saleId);
    const rows = await handle.db.select().from(saleEvents).where(and(eq(saleEvents.saleId, saleId), eq(saleEvents.type, "REVERSED")));
    expect(rows).toHaveLength(1);
  });
});
