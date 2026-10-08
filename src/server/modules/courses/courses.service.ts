import { and, asc, eq, ilike, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { assertPermission } from "@/server/authz/permissions";
import type { ServiceContext } from "@/server/context";
import { isUniqueViolation } from "@/server/db/errors";
import { courseCosts, courses } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { ConflictError, NotFoundError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { idSchema, parseInput } from "@/server/validation";

/**
 * Cursos (Documento Mestre §10 e §13).
 *
 * Dois "contratos" de saída, separados por design:
 * - CourseOption  → { id, name, institutionName } de cursos ATIVOS. Único
 *   formato disponível para SUPERVISOR e SELLER (e usado por todos nos
 *   cadastros de lead/venda).
 * - CourseWithCost → inclui o custo da bolsa. Só funções `*WithCost`, que
 *   exigem `courses:viewCost` (ADMIN), fazem join com course_costs.
 */

export type CourseOption = { id: string; name: string; institutionName: string };

export type CourseWithCost = {
  id: string;
  name: string;
  institutionName: string;
  active: boolean;
  scholarshipCostCents: number;
  createdAt: Date;
  updatedAt: Date;
  costUpdatedAt: Date;
};

const NAME_TAKEN = "Este curso já está cadastrado nesta instituição.";
const UNIQUE_CONSTRAINT = "courses_name_institution_unique";

/** Teto de segurança contra erros de digitação: R$ 1.000.000,00. */
const MAX_COST_CENTS = 100_000_000;

const courseNameSchema = z
  .string()
  .trim()
  .min(2, "Informe ao menos 2 caracteres.")
  .max(150, "Use no máximo 150 caracteres.");

const institutionNameSchema = z
  .string()
  .trim()
  .min(2, "Informe a instituição (ao menos 2 caracteres).")
  .max(150, "Use no máximo 150 caracteres.");

const costCentsSchema = z
  .number({ error: "Informe um custo válido (ex.: 300,00)." })
  .int("Informe um custo válido (ex.: 300,00).")
  .min(0, "O custo não pode ser negativo.")
  .max(MAX_COST_CENTS, "Valor acima do limite permitido.");

// ---------------------------------------------------------------------------
// Lista operacional — todos os perfis, SEM custo
// ---------------------------------------------------------------------------

export async function listActiveCourseOptions({ db, actor }: ServiceContext): Promise<CourseOption[]> {
  assertPermission(actor, "courses:list");
  return db
    .select({ id: courses.id, name: courses.name, institutionName: courses.institutionName })
    .from(courses)
    .where(eq(courses.active, true))
    .orderBy(asc(courses.name), asc(courses.institutionName));
}

// ---------------------------------------------------------------------------
// Gestão — somente ADMIN
// ---------------------------------------------------------------------------

const courseWithCost = {
  id: courses.id,
  name: courses.name,
  institutionName: courses.institutionName,
  active: courses.active,
  scholarshipCostCents: courseCosts.costCents,
  createdAt: courses.createdAt,
  updatedAt: courses.updatedAt,
  costUpdatedAt: courseCosts.updatedAt,
};

const listFiltersSchema = z.strictObject({
  search: z.string().trim().max(150).optional(),
  active: z.boolean().optional(),
});

/** ADMIN: cursos ativos e inativos, com custo. */
export async function listCoursesWithCost({ db, actor }: ServiceContext, rawFilters: unknown = {}): Promise<CourseWithCost[]> {
  assertPermission(actor, "courses:viewCost");
  const filters = parseInput(listFiltersSchema, rawFilters);
  const conditions: SQL[] = [];
  if (filters.active !== undefined) conditions.push(eq(courses.active, filters.active));
  if (filters.search) {
    const term = `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`;
    conditions.push(or(ilike(courses.name, term), ilike(courses.institutionName, term))!);
  }

  return db
    .select(courseWithCost)
    .from(courses)
    .innerJoin(courseCosts, eq(courseCosts.courseId, courses.id))
    .where(and(...conditions))
    .orderBy(asc(courses.name), asc(courses.institutionName));
}

export async function getCourseWithCost({ db, actor }: ServiceContext, rawId: unknown): Promise<CourseWithCost> {
  assertPermission(actor, "courses:viewCost");
  const course = await findCourseWithCost(db, parseInput(idSchema, rawId));
  if (!course) throw new NotFoundError();
  return course;
}

async function findCourseWithCost(db: Database, id: string): Promise<CourseWithCost | undefined> {
  const [course] = await db
    .select(courseWithCost)
    .from(courses)
    .innerJoin(courseCosts, eq(courseCosts.courseId, courses.id))
    .where(eq(courses.id, id))
    .limit(1);
  return course;
}

const createCourseSchema = z.strictObject({
  name: courseNameSchema,
  institutionName: institutionNameSchema,
  scholarshipCostCents: costCentsSchema,
});

export async function createCourse({ db, actor }: ServiceContext, input: unknown): Promise<CourseWithCost> {
  assertPermission(actor, "courses:manage");
  const data = parseInput(createCourseSchema, input);

  try {
    const id = await db.transaction(async (tx) => {
      const [created] = await tx.insert(courses).values({ name: data.name, institutionName: data.institutionName }).returning({ id: courses.id });
      await tx.insert(courseCosts).values({ courseId: created.id, costCents: data.scholarshipCostCents, updatedBy: actor.userId });
      await recordAudit(tx, {
        actorId: actor.userId,
        action: "course.created",
        entityType: "course",
        entityId: created.id,
        metadata: { name: data.name, institutionName: data.institutionName, scholarshipCostCents: data.scholarshipCostCents },
      });
      return created.id;
    });
    return (await findCourseWithCost(db, id))!;
  } catch (error) {
    if (isUniqueViolation(error, UNIQUE_CONSTRAINT)) throw new ConflictError(NAME_TAKEN);
    throw error;
  }
}

const updateCourseSchema = z.strictObject({
  name: courseNameSchema.optional(),
  institutionName: institutionNameSchema.optional(),
  scholarshipCostCents: costCentsSchema.optional(),
});

export async function updateCourse({ db, actor }: ServiceContext, rawId: unknown, input: unknown): Promise<CourseWithCost> {
  assertPermission(actor, "courses:manage");
  const id = parseInput(idSchema, rawId);
  const data = parseInput(updateCourseSchema, input);

  try {
    await db.transaction(async (tx) => {
      const before = await findCourseWithCost(tx, id);
      if (!before) throw new NotFoundError();

      const changes: Record<string, { from: string; to: string }> = {};
      if (data.name !== undefined && data.name !== before.name) changes.name = { from: before.name, to: data.name };
      if (data.institutionName !== undefined && data.institutionName !== before.institutionName) {
        changes.institutionName = { from: before.institutionName, to: data.institutionName };
      }
      if (Object.keys(changes).length > 0) {
        await tx.update(courses).set({ name: data.name, institutionName: data.institutionName }).where(eq(courses.id, id));
        await recordAudit(tx, {
          actorId: actor.userId,
          action: "course.updated",
          entityType: "course",
          entityId: id,
          metadata: { changes },
        });
      }

      if (data.scholarshipCostCents !== undefined && data.scholarshipCostCents !== before.scholarshipCostCents) {
        await tx
          .update(courseCosts)
          .set({ costCents: data.scholarshipCostCents, updatedBy: actor.userId })
          .where(eq(courseCosts.courseId, id));
        await recordAudit(tx, {
          actorId: actor.userId,
          action: "course.cost_changed",
          entityType: "course",
          entityId: id,
          metadata: {
            name: data.name ?? before.name,
            institutionName: data.institutionName ?? before.institutionName,
            fromCents: before.scholarshipCostCents, toCents: data.scholarshipCostCents,
          },
        });
      }
    });
  } catch (error) {
    if (isUniqueViolation(error, UNIQUE_CONSTRAINT)) throw new ConflictError(NAME_TAKEN);
    throw error;
  }
  return (await findCourseWithCost(db, id))!;
}

export async function setCourseActive({ db, actor }: ServiceContext, rawId: unknown, rawActive: unknown): Promise<void> {
  assertPermission(actor, "courses:manage");
  const id = parseInput(idSchema, rawId);
  const active = parseInput(z.boolean(), rawActive);

  await db.transaction(async (tx) => {
    const [course] = await tx
      .select({ name: courses.name, institutionName: courses.institutionName, active: courses.active })
      .from(courses)
      .where(eq(courses.id, id))
      .limit(1);
    if (!course) throw new NotFoundError();
    if (course.active === active) return;

    await tx.update(courses).set({ active }).where(eq(courses.id, id));
    await recordAudit(tx, {
      actorId: actor.userId,
      action: active ? "course.activated" : "course.deactivated",
      entityType: "course",
      entityId: id,
      metadata: { name: course.name, institutionName: course.institutionName },
    });
  });
}
