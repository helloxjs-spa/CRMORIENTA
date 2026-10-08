import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { users } from "./organization";

/**
 * Curso oferecido por uma instituição (o mesmo curso pode existir em várias,
 * com custos diferentes). Propositalmente SEM coluna de custo: qualquer
 * consulta a esta tabela (inclusive `select *`) é segura para vendedor e
 * supervisor. Cursos nunca são apagados; usa-se `active`.
 * Espelha database/migrations/001_supabase_initial_schema.sql.
 */
export const courses = pgTable(
  "courses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    institutionName: text("institution_name").notNull(),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("courses_name_institution_unique").on(sql`lower(btrim(${t.name}))`, sql`lower(btrim(${t.institutionName}))`),
    check("courses_name_not_blank", sql`btrim(${t.name}) <> ''`),
    check("courses_institution_not_blank", sql`btrim(${t.institutionName}) <> ''`),
  ],
);

/**
 * Custo da bolsa (1:1 com o curso), em centavos. Informação restrita ao ADMIN:
 * somente funções que exigem `courses:viewCost` fazem join com esta tabela.
 * O histórico de alterações fica em audit_events (course.cost_changed).
 */
export const courseCosts = pgTable(
  "course_costs",
  {
    courseId: uuid("course_id")
      .primaryKey()
      .references(() => courses.id, { onDelete: "restrict" }),
    costCents: integer("cost_cents").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [check("course_costs_non_negative", sql`${t.costCents} >= 0`)],
);

export type Course = typeof courses.$inferSelect;
