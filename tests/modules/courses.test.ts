import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents, courseCosts, courses } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import {
  createCourse,
  getCourseWithCost,
  listActiveCourseOptions,
  listCoursesWithCost,
  setCourseActive,
  updateCourse,
} from "@/server/modules/courses/courses.service";
import { createTestDatabase, seedOrganization } from "../support/db";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let pedagogiaId: string;
let historiaId: string;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  const admin = await org.ctx(org.ids.admin);
  pedagogiaId = (await createCourse(admin, { name: "Pedagogia", scholarshipCostCents: 300_00 })).id;
  historiaId = (await createCourse(admin, { name: "História", scholarshipCostCents: 250_00 })).id;
  const inactive = await createCourse(admin, { name: "Curso Antigo", scholarshipCostCents: 99_00 });
  await setCourseActive(admin, inactive.id, false);
});
afterAll(() => handle.close());

describe("lista operacional (sem custo)", () => {
  for (const who of ["sellerA1", "supA", "admin"] as const) {
    it(`${who}: recebe apenas { id, name } de cursos ativos`, async () => {
      const options = await listActiveCourseOptions(await org.ctx(org.ids[who]));
      expect(options.map((c) => c.name)).toEqual(["História", "Pedagogia"]);
      for (const option of options) expect(Object.keys(option).sort()).toEqual(["id", "name"]);
    });
  }

  it("o payload serializado não contém o valor do custo", async () => {
    const json = JSON.stringify(await listActiveCourseOptions(await org.ctx(org.ids.sellerA1)));
    expect(json).not.toMatch(/cost|30000|25000/i);
  });

  it("curso inativo não aparece na lista operacional", async () => {
    const names = (await listActiveCourseOptions(await org.ctx(org.ids.supA))).map((c) => c.name);
    expect(names).not.toContain("Curso Antigo");
  });
});

describe("custo da bolsa é exclusivo do ADMIN", () => {
  for (const who of ["sellerA1", "supA"] as const) {
    it(`${who}: não lista nem consulta cursos com custo`, async () => {
      const ctx = await org.ctx(org.ids[who]);
      await expect(listCoursesWithCost(ctx)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getCourseWithCost(ctx, pedagogiaId)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it(`${who}: não cria, edita, altera custo nem ativa/desativa`, async () => {
      const ctx = await org.ctx(org.ids[who]);
      await expect(createCourse(ctx, { name: "Hack", scholarshipCostCents: 1 })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateCourse(ctx, pedagogiaId, { scholarshipCostCents: 1 })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateCourse(ctx, pedagogiaId, { name: "Hack" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setCourseActive(ctx, pedagogiaId, false)).rejects.toBeInstanceOf(ForbiddenError);
    });
  }

  it("tentativas negadas não alteram nada no banco", async () => {
    const [cost] = await handle.db.select().from(courseCosts).where(eq(courseCosts.courseId, pedagogiaId));
    const [course] = await handle.db.select().from(courses).where(eq(courses.id, pedagogiaId));
    expect(cost.costCents).toBe(300_00);
    expect(course).toMatchObject({ name: "Pedagogia", active: true });
  });

  it("a mensagem de erro negado não revela o custo", async () => {
    const error = await getCourseWithCost(await org.ctx(org.ids.sellerA1), pedagogiaId).catch((e: unknown) => e);
    expect(JSON.stringify({ message: (error as Error).message })).not.toMatch(/30000|300,00/);
  });
});

describe("gestão pelo ADMIN", () => {
  it("lista ativos e inativos com custo", async () => {
    const list = await listCoursesWithCost(await org.ctx(org.ids.admin));
    expect(list.map((c) => [c.name, c.active, c.scholarshipCostCents])).toEqual([
      ["Curso Antigo", false, 99_00],
      ["História", true, 250_00],
      ["Pedagogia", true, 300_00],
    ]);
  });

  it("filtra por status e busca", async () => {
    const admin = await org.ctx(org.ids.admin);
    expect((await listCoursesWithCost(admin, { active: false })).map((c) => c.name)).toEqual(["Curso Antigo"]);
    expect((await listCoursesWithCost(admin, { search: "pedag" })).map((c) => c.name)).toEqual(["Pedagogia"]);
  });

  it("visualiza um curso com custo", async () => {
    await expect(getCourseWithCost(await org.ctx(org.ids.admin), historiaId)).resolves.toMatchObject({
      name: "História",
      scholarshipCostCents: 250_00,
    });
  });

  it("altera nome e custo, auditando o custo anterior e o novo", async () => {
    const admin = await org.ctx(org.ids.admin);
    const updated = await updateCourse(admin, historiaId, { name: "História EAD", scholarshipCostCents: 275_50 });
    expect(updated).toMatchObject({ name: "História EAD", scholarshipCostCents: 275_50 });

    const [event] = await handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "course.cost_changed"), eq(auditEvents.entityId, historiaId)));
    expect(event).toMatchObject({ actorId: org.ids.admin, teamId: null });
    expect(event.metadata).toMatchObject({ fromCents: 250_00, toCents: 275_50 });
  });

  it("desativa e reativa: some e volta na lista operacional", async () => {
    const admin = await org.ctx(org.ids.admin);
    const seller = await org.ctx(org.ids.sellerA1);
    await setCourseActive(admin, pedagogiaId, false);
    expect((await listActiveCourseOptions(seller)).map((c) => c.id)).not.toContain(pedagogiaId);
    await setCourseActive(admin, pedagogiaId, true);
    expect((await listActiveCourseOptions(seller)).map((c) => c.id)).toContain(pedagogiaId);
  });

  it("nome é único sem diferenciar maiúsculas", async () => {
    await expect(createCourse(await org.ctx(org.ids.admin), { name: "PEDAGOGIA", scholarshipCostCents: 1 })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("valida custo: obrigatório, inteiro em centavos, não negativo", async () => {
    const admin = await org.ctx(org.ids.admin);
    for (const scholarshipCostCents of [undefined, -1, 10.5, "300"]) {
      await expect(createCourse(admin, { name: "Curso X", scholarshipCostCents })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("rejeita campos não previstos (mass assignment)", async () => {
    const admin = await org.ctx(org.ids.admin);
    await expect(createCourse(admin, { name: "Curso Y", scholarshipCostCents: 1, active: false })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateCourse(admin, pedagogiaId, { id: historiaId })).rejects.toBeInstanceOf(ValidationError);
  });

  it("curso inexistente → NotFound", async () => {
    await expect(getCourseWithCost(await org.ctx(org.ids.admin), "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("integridade no banco", () => {
  it("cursos e custos não podem ser apagados fisicamente", async () => {
    await expect(handle.db.delete(courseCosts).where(eq(courseCosts.courseId, pedagogiaId))).rejects.toThrow();
    await expect(handle.db.delete(courses).where(eq(courses.id, pedagogiaId))).rejects.toThrow();
  });

  it("custo negativo é recusado pelo banco", async () => {
    await expect(handle.db.update(courseCosts).set({ costCents: -1 }).where(eq(courseCosts.courseId, pedagogiaId))).rejects.toThrow();
  });
});
