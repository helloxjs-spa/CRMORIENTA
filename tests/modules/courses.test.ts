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
let pedagogiaAlphaId: string;
let pedagogiaBetaId: string;
let historiaId: string;

const ALPHA = "Faculdade Alpha";
const BETA = "Faculdade Beta";

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  const admin = await org.ctx(org.ids.admin);
  pedagogiaAlphaId = (await createCourse(admin, { name: "Pedagogia", institutionName: ALPHA, scholarshipCostCents: 300_00 })).id;
  pedagogiaBetaId = (await createCourse(admin, { name: "Pedagogia", institutionName: BETA, scholarshipCostCents: 420_00 })).id;
  historiaId = (await createCourse(admin, { name: "História", institutionName: ALPHA, scholarshipCostCents: 250_00 })).id;
  const inactive = await createCourse(admin, { name: "Curso Antigo", institutionName: ALPHA, scholarshipCostCents: 99_00 });
  await setCourseActive(admin, inactive.id, false);
});
afterAll(() => handle.close());

describe("lista operacional (sem custo)", () => {
  for (const who of ["sellerA1", "supA", "admin"] as const) {
    it(`${who}: recebe apenas { id, name, institutionName } de cursos ativos`, async () => {
      const options = await listActiveCourseOptions(await org.ctx(org.ids[who]));
      expect(options.map((c) => [c.name, c.institutionName])).toEqual([
        ["História", ALPHA],
        ["Pedagogia", ALPHA],
        ["Pedagogia", BETA],
      ]);
      for (const option of options) expect(Object.keys(option).sort()).toEqual(["id", "institutionName", "name"]);
    });
  }

  it("o payload serializado não contém custo", async () => {
    const json = JSON.stringify(await listActiveCourseOptions(await org.ctx(org.ids.sellerA1)));
    expect(json).not.toMatch(/cost|30000|42000|25000/i);
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
      await expect(getCourseWithCost(ctx, pedagogiaAlphaId)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it(`${who}: não cria, edita, altera custo/instituição nem ativa/desativa`, async () => {
      const ctx = await org.ctx(org.ids[who]);
      await expect(createCourse(ctx, { name: "Hack", institutionName: ALPHA, scholarshipCostCents: 1 })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(updateCourse(ctx, pedagogiaAlphaId, { scholarshipCostCents: 1 })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateCourse(ctx, pedagogiaAlphaId, { name: "Hack" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateCourse(ctx, pedagogiaAlphaId, { institutionName: "Hack" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setCourseActive(ctx, pedagogiaAlphaId, false)).rejects.toBeInstanceOf(ForbiddenError);
    });
  }

  it("tentativas negadas não alteram nada no banco", async () => {
    const [cost] = await handle.db.select().from(courseCosts).where(eq(courseCosts.courseId, pedagogiaAlphaId));
    const [course] = await handle.db.select().from(courses).where(eq(courses.id, pedagogiaAlphaId));
    expect(cost.costCents).toBe(300_00);
    expect(course).toMatchObject({ name: "Pedagogia", institutionName: ALPHA, active: true });
  });

  it("a mensagem de erro negado não revela o custo", async () => {
    const error = await getCourseWithCost(await org.ctx(org.ids.sellerA1), pedagogiaAlphaId).catch((e: unknown) => e);
    expect(JSON.stringify({ message: (error as Error).message })).not.toMatch(/30000|300,00/);
  });
});

describe("mesmo curso em instituições diferentes", () => {
  it("cada instituição tem o seu custo", async () => {
    const admin = await org.ctx(org.ids.admin);
    await expect(getCourseWithCost(admin, pedagogiaAlphaId)).resolves.toMatchObject({ institutionName: ALPHA, scholarshipCostCents: 300_00 });
    await expect(getCourseWithCost(admin, pedagogiaBetaId)).resolves.toMatchObject({ institutionName: BETA, scholarshipCostCents: 420_00 });
  });

  it("o par curso + instituição é único (sem diferenciar maiúsculas nem espaços)", async () => {
    const admin = await org.ctx(org.ids.admin);
    await expect(
      createCourse(admin, { name: "  PEDAGOGIA ", institutionName: "faculdade alpha", scholarshipCostCents: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
    const error = await createCourse(admin, { name: "pedagogia", institutionName: BETA, scholarshipCostCents: 1 }).catch((e: Error) => e);
    expect((error as Error).message).toBe("Este curso já está cadastrado nesta instituição.");
  });

  it("renomear para um par já existente é recusado", async () => {
    await expect(
      updateCourse(await org.ctx(org.ids.admin), historiaId, { name: "Pedagogia", institutionName: BETA }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("instituição é obrigatória", async () => {
    const admin = await org.ctx(org.ids.admin);
    for (const institutionName of [undefined, "", "   ", "X"]) {
      await expect(createCourse(admin, { name: "Direito", institutionName, scholarshipCostCents: 1 })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });
});

describe("gestão pelo ADMIN", () => {
  it("lista ativos e inativos com custo e instituição", async () => {
    const list = await listCoursesWithCost(await org.ctx(org.ids.admin));
    expect(list.map((c) => [c.name, c.institutionName, c.active, c.scholarshipCostCents])).toEqual([
      ["Curso Antigo", ALPHA, false, 99_00],
      ["História", ALPHA, true, 250_00],
      ["Pedagogia", ALPHA, true, 300_00],
      ["Pedagogia", BETA, true, 420_00],
    ]);
  });

  it("filtra por status e busca por curso ou instituição", async () => {
    const admin = await org.ctx(org.ids.admin);
    expect((await listCoursesWithCost(admin, { active: false })).map((c) => c.name)).toEqual(["Curso Antigo"]);
    expect((await listCoursesWithCost(admin, { search: "pedag" })).map((c) => c.institutionName)).toEqual([ALPHA, BETA]);
    expect((await listCoursesWithCost(admin, { search: "beta" })).map((c) => c.name)).toEqual(["Pedagogia"]);
  });

  it("altera nome, instituição e custo, auditando de/para", async () => {
    const admin = await org.ctx(org.ids.admin);
    const updated = await updateCourse(admin, historiaId, {
      name: "História EAD",
      institutionName: "Universidade Gama",
      scholarshipCostCents: 275_50,
    });
    expect(updated).toMatchObject({ name: "História EAD", institutionName: "Universidade Gama", scholarshipCostCents: 275_50 });

    const events = await handle.db.select().from(auditEvents).where(eq(auditEvents.entityId, historiaId));
    const updatedEvent = events.find((e) => e.action === "course.updated");
    const costEvent = events.find((e) => e.action === "course.cost_changed");
    expect(updatedEvent?.metadata).toEqual({
      changes: {
        name: { from: "História", to: "História EAD" },
        institutionName: { from: ALPHA, to: "Universidade Gama" },
      },
    });
    expect(costEvent).toMatchObject({ actorId: org.ids.admin, teamId: null });
    expect(costEvent?.metadata).toMatchObject({ fromCents: 250_00, toCents: 275_50, institutionName: "Universidade Gama" });
  });

  it("desativa e reativa: some e volta na lista operacional", async () => {
    const admin = await org.ctx(org.ids.admin);
    const seller = await org.ctx(org.ids.sellerA1);
    await setCourseActive(admin, pedagogiaAlphaId, false);
    const ids = (await listActiveCourseOptions(seller)).map((c) => c.id);
    expect(ids).not.toContain(pedagogiaAlphaId);
    expect(ids).toContain(pedagogiaBetaId);
    await setCourseActive(admin, pedagogiaAlphaId, true);
    expect((await listActiveCourseOptions(seller)).map((c) => c.id)).toContain(pedagogiaAlphaId);

    const [event] = await handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "course.deactivated"), eq(auditEvents.entityId, pedagogiaAlphaId)));
    expect(event.metadata).toEqual({ name: "Pedagogia", institutionName: ALPHA });
  });

  it("valida custo: obrigatório, inteiro em centavos, não negativo", async () => {
    const admin = await org.ctx(org.ids.admin);
    for (const scholarshipCostCents of [undefined, -1, 10.5, "300"]) {
      await expect(createCourse(admin, { name: "Curso X", institutionName: ALPHA, scholarshipCostCents })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it("rejeita campos não previstos (mass assignment)", async () => {
    const admin = await org.ctx(org.ids.admin);
    await expect(
      createCourse(admin, { name: "Curso Y", institutionName: ALPHA, scholarshipCostCents: 1, active: false }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(updateCourse(admin, pedagogiaAlphaId, { id: historiaId })).rejects.toBeInstanceOf(ValidationError);
  });

  it("curso inexistente → NotFound", async () => {
    await expect(getCourseWithCost(await org.ctx(org.ids.admin), "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("integridade no banco", () => {
  it("cursos e custos não podem ser apagados fisicamente", async () => {
    await expect(handle.db.delete(courseCosts).where(eq(courseCosts.courseId, pedagogiaAlphaId))).rejects.toThrow();
    await expect(handle.db.delete(courses).where(eq(courses.id, pedagogiaAlphaId))).rejects.toThrow();
  });

  it("custo negativo é recusado pelo banco", async () => {
    await expect(
      handle.db.update(courseCosts).set({ costCents: -1 }).where(eq(courseCosts.courseId, pedagogiaAlphaId)),
    ).rejects.toThrow();
  });

  it("instituição em branco é recusada pelo banco", async () => {
    await expect(handle.db.update(courses).set({ institutionName: "  " }).where(eq(courses.id, pedagogiaAlphaId))).rejects.toThrow();
  });
});
