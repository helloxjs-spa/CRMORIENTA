import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "@/server/context";
import type { DatabaseHandle } from "@/server/db/connect";
import { courseCosts, courses } from "@/server/db/schema";
import { createCourse } from "@/server/modules/courses/courses.service";
import { createTestDatabase, seedOrganization } from "../support/db";

/**
 * Ataque direto às Server Actions (como um POST forjado faria), sem passar
 * pela tela. Apenas a leitura do cookie é substituída: action → runAction →
 * serviço → banco rodam de verdade.
 */
const session = vi.hoisted(() => ({ current: null as ServiceContext | null }));
vi.mock("@/server/next/session", () => ({
  requireServiceContext: async () => {
    if (!session.current) throw new Error("sem sessão no teste");
    return session.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { createCourseAction, setCourseActiveAction, updateCourseAction } = await import("@/app/(app)/cursos/actions");

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let courseId: string;

const IDLE = { status: "idle" } as const;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  courseId = (await createCourse(await org.ctx(org.ids.admin), { name: "Administração", scholarshipCostCents: 432_10 })).id;
});
afterAll(() => handle.close());

describe("Server Actions de cursos chamadas diretamente", () => {
  for (const who of ["sellerA1", "supA"] as const) {
    it(`${who}: recebe erro de permissão sem nenhum dado do curso ou custo`, async () => {
      session.current = await org.ctx(org.ids[who]);
      const results = [
        await createCourseAction(IDLE, form({ name: "Invasão", scholarshipCost: "1,00" })),
        await updateCourseAction(IDLE, form({ courseId, name: "Invasão", scholarshipCost: "1,00" })),
        await setCourseActiveAction(IDLE, form({ courseId, active: "false" })),
      ];
      for (const result of results) {
        expect(result).toMatchObject({ status: "error", message: "Você não tem permissão para executar esta ação." });
        const payload = JSON.stringify(result);
        expect(payload).not.toMatch(/43210|432,10|Administração|cost/i);
      }
    });
  }

  it("nenhuma tentativa negada alterou o banco", async () => {
    const [course] = await handle.db.select().from(courses).where(eq(courses.id, courseId));
    const [cost] = await handle.db.select().from(courseCosts).where(eq(courseCosts.courseId, courseId));
    expect(course).toMatchObject({ name: "Administração", active: true });
    expect(cost.costCents).toBe(432_10);
    expect(await handle.db.select().from(courses).where(eq(courses.name, "Invasão"))).toHaveLength(0);
  });

  it("admin: cria e altera custo em reais, convertido para centavos", async () => {
    session.current = await org.ctx(org.ids.admin);
    const created = await createCourseAction(IDLE, form({ name: "Direito", scholarshipCost: "1.234,56" }));
    expect(created).toMatchObject({ status: "success" });
    const [row] = await handle.db
      .select({ cost: courseCosts.costCents })
      .from(courses)
      .innerJoin(courseCosts, eq(courseCosts.courseId, courses.id))
      .where(eq(courses.name, "Direito"));
    expect(row.cost).toBe(1234_56);
  });

  it("admin: custo inválido aponta erro no campo", async () => {
    session.current = await org.ctx(org.ids.admin);
    const result = await createCourseAction(IDLE, form({ name: "Medicina", scholarshipCost: "abc" }));
    expect(result).toMatchObject({ status: "error", fieldErrors: { scholarshipCostCents: ["Informe um custo válido (ex.: 300,00)."] } });
  });
});
