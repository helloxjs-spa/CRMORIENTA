import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { courses, leads } from "@/server/db/schema";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { listCourseFilterOptions } from "@/server/modules/courses/courses.service";
import {
  countDecisionQueue,
  createLead,
  listLeadSellers,
  listLeads,
  redistributeLead,
  trashLead,
} from "@/server/modules/leads/leads.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourse, setLeadStage } from "../support/leads";

/**
 * Listagem paginada: escopo primeiro, depois filtros, LIMIT/OFFSET e
 * contagem no banco. Equipe A: A1 (30 leads) e A2 (5); equipe B: B1 (7).
 */

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let pedagogia: string;
let historia: string;
const ids = { a1: [] as string[], a2: [] as string[], b1: [] as string[] };

let seq = 0;
async function seed(sellerId: string, bucket: string[], count: number, prefix: string) {
  for (let i = 1; i <= count; i++) {
    const n = ++seq;
    const lead = await createLead(await org.ctx(sellerId), {
      name: `${prefix} ${String(i).padStart(2, "0")}`,
      phone: `(79) 9${String(n).padStart(8, "0")}`,
      interestCourseId: n % 3 === 0 ? historia : pedagogia,
    });
    bucket.push(lead.id);
  }
}

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  pedagogia = await insertCourse(handle, "Pedagogia");
  historia = await insertCourse(handle, "História");
  await seed(org.ids.sellerA1, ids.a1, 30, "Ana");
  await seed(org.ids.sellerA2, ids.a2, 5, "Bruno");
  await seed(org.ids.sellerB1, ids.b1, 7, "Carla");
});
afterAll(() => handle.close());

describe("paginação", () => {
  it("vendedor pagina só a própria carteira: total, páginas e itens sem repetição", async () => {
    const ctx = await org.ctx(org.ids.sellerA1);
    const first = await listLeads(ctx, { page: 1, pageSize: 25 });
    const second = await listLeads(ctx, { page: 2, pageSize: 25 });
    expect(first).toMatchObject({ page: 1, pageSize: 25, total: 30, totalPages: 2 });
    expect(first.items).toHaveLength(25);
    expect(second).toMatchObject({ page: 2, total: 30, totalPages: 2 });
    expect(second.items).toHaveLength(5);
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((l) => l.id)).size).toBe(30);
    expect(all.every((l) => l.ownerId === org.ids.sellerA1)).toBe(true);
    // Mais recentes primeiro.
    expect(first.items[0].name).toBe("Ana 30");
  });

  it("padrão de 25 por página; página além do fim cai na última", async () => {
    const ctx = await org.ctx(org.ids.sellerA1);
    expect(await listLeads(ctx)).toMatchObject({ page: 1, pageSize: 25 });
    const beyond = await listLeads(ctx, { page: 99 });
    expect(beyond).toMatchObject({ page: 2, totalPages: 2 });
    expect(beyond.items).toHaveLength(5);
  });

  it("aceita só 25, 50 ou 100 por página e página >= 1", async () => {
    const ctx = await org.ctx(org.ids.sellerA1);
    expect((await listLeads(ctx, { pageSize: 50 })).items).toHaveLength(30);
    for (const filters of [{ pageSize: 30 }, { pageSize: 1000 }, { page: 0 }, { page: 1.5 }]) {
      await expect(listLeads(ctx, filters)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("supervisor pagina a equipe; filtros de outra equipe ou vendedor não furam o escopo", async () => {
    const ctx = await org.ctx(org.ids.supA);
    const page = await listLeads(ctx, { pageSize: 100 });
    expect(page.total).toBe(35);
    expect(page.items.every((l) => l.teamId === org.ids.teamA)).toBe(true);
    expect((await listLeads(ctx, { teamId: org.ids.teamB })).total).toBe(0);
    expect((await listLeads(ctx, { ownerId: org.ids.sellerB1 })).total).toBe(0);
    expect((await listLeads(ctx, { ownerId: org.ids.sellerA2 })).total).toBe(5);
  });

  it("admin vê todas as equipes e filtra por equipe e vendedor", async () => {
    const ctx = await org.ctx(org.ids.admin);
    expect((await listLeads(ctx)).total).toBe(42);
    expect((await listLeads(ctx, { teamId: org.ids.teamB })).total).toBe(7);
    expect((await listLeads(ctx, { ownerId: org.ids.sellerA2 })).total).toBe(5);
  });

  it("vendedor filtrando por outro vendedor ou equipe não vê nada", async () => {
    const ctx = await org.ctx(org.ids.sellerA1);
    expect((await listLeads(ctx, { ownerId: org.ids.sellerA2 })).total).toBe(0);
    expect((await listLeads(ctx, { teamId: org.ids.teamB })).total).toBe(0);
  });
});

describe("busca e filtros", () => {
  it("busca por nome", async () => {
    const result = await listLeads(await org.ctx(org.ids.supA), { search: "bruno" });
    expect(result.total).toBe(5);
    expect(await listLeads(await org.ctx(org.ids.sellerA1), { search: "bruno" })).toMatchObject({ total: 0 });
  });

  it("busca por telefone formatado, com +55 ou só um trecho", async () => {
    const [target] = await handle.db.select().from(leads).where(eq(leads.id, ids.b1[0]));
    const national = target.phone.slice(2);
    const admin = await org.ctx(org.ids.admin);
    for (const search of [`(${national.slice(0, 2)}) ${national.slice(2, 7)}-${national.slice(7)}`, `+55 ${national}`, national.slice(-6)]) {
      expect((await listLeads(admin, { search })).items.map((l) => l.id), search).toEqual([target.id]);
    }
    // O mesmo telefone, buscado por quem não tem acesso, não aparece.
    expect((await listLeads(await org.ctx(org.ids.sellerA1), { search: national })).total).toBe(0);
  });

  it("filtra por etapa e por curso", async () => {
    for (const id of ids.a1.slice(0, 3)) await setLeadStage(handle, id, "FOLLOW_UP_1", 10);
    const seller = await org.ctx(org.ids.sellerA1);
    expect((await listLeads(seller, { stage: "FOLLOW_UP_1" })).total).toBe(3);

    const all = (await listLeads(seller, { pageSize: 100 })).items;
    const expected = all.filter((l) => l.interestCourseId === historia).length;
    expect(expected).toBeGreaterThan(0);
    const filtered = await listLeads(seller, { courseId: historia, pageSize: 100 });
    expect(filtered.total).toBe(expected);
    expect(filtered.items.every((l) => l.interestCourseName === "História")).toBe(true);
  });
});

describe("fila de decisão e Follow-up 3 vencido", () => {
  let expired: string;

  beforeAll(async () => {
    expired = ids.a1[10];
    await setLeadStage(handle, expired, "FOLLOW_UP_3", -1);
  });

  it("o vendedor continua vendo o lead, marcado como aguardando o supervisor, sem poder decidir", async () => {
    const seller = await org.ctx(org.ids.sellerA1);
    const item = (await listLeads(seller, { pageSize: 100 })).items.find((l) => l.id === expired);
    expect(item).toMatchObject({ stage: "FOLLOW_UP_3", queueReason: "FOLLOW_UP_3_EXPIRED", ownerId: org.ids.sellerA1 });
    await expect(redistributeLead(seller, expired, { toSellerId: org.ids.sellerA2 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(trashLead(seller, expired)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listLeads(seller, { queue: "ALL" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(countDecisionQueue(seller)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("aparece na fila e na contagem do supervisor da equipe, não na de outra", async () => {
    const supA = await org.ctx(org.ids.supA);
    expect(await countDecisionQueue(supA)).toEqual({ unassigned: 0, followUp3Expired: 1 });
    expect((await listLeads(supA, { queue: "FOLLOW_UP_3_EXPIRED" })).items.map((l) => l.id)).toEqual([expired]);
    expect((await listLeads(supA, { queue: "UNASSIGNED" })).total).toBe(0);

    const supB = await org.ctx(org.ids.supB);
    expect(await countDecisionQueue(supB)).toEqual({ unassigned: 0, followUp3Expired: 0 });
    expect((await listLeads(supB, { queue: "ALL" })).total).toBe(0);
    expect(await countDecisionQueue(await org.ctx(org.ids.admin))).toEqual({ unassigned: 0, followUp3Expired: 1 });
  });
});

describe("Lixeira na listagem", () => {
  it("vendedor não lista a Lixeira; supervisor vê quem enviou e quando", async () => {
    const trashed = ids.a2[0];
    await trashLead(await org.ctx(org.ids.supA), trashed);

    expect((await listLeads(await org.ctx(org.ids.sellerA2), { status: "TRASHED" })).total).toBe(0);
    const page = await listLeads(await org.ctx(org.ids.supA), { status: "TRASHED" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: trashed, status: "TRASHED", trashedByName: "Supervisor A", ownerName: "Vendedor A2" });
    expect(page.items[0].trashedAt).toBeInstanceOf(Date);
    expect((await listLeads(await org.ctx(org.ids.supB), { status: "TRASHED" })).total).toBe(0);
  });
});

describe("opções de filtro", () => {
  it("vendedores no escopo: supervisor só os da equipe; admin todos; vendedor não acessa", async () => {
    expect((await listLeadSellers(await org.ctx(org.ids.supA))).map((s) => s.name)).toEqual(["Vendedor A1", "Vendedor A2"]);
    expect((await listLeadSellers(await org.ctx(org.ids.admin))).map((s) => s.name)).toEqual(["Vendedor A1", "Vendedor A2", "Vendedor B1"]);
    await expect(listLeadSellers(await org.ctx(org.ids.sellerA1))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cursos para filtro incluem inativos e nunca o custo", async () => {
    await handle.db.update(courses).set({ active: false }).where(eq(courses.id, historia));
    const options = await listCourseFilterOptions(await org.ctx(org.ids.sellerA1));
    expect(options.map((c) => [c.name, c.active])).toEqual([
      ["História", false],
      ["Pedagogia", true],
    ]);
    expect(Object.keys(options[0]).sort()).toEqual(["active", "id", "institutionName", "name"]);
  });
});
