import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const USER_ROLES = ["ADMIN", "SUPERVISOR", "SELLER"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const userRole = pgEnum("user_role", USER_ROLES);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/**
 * Usuários do sistema. Um vendedor pertence a no máximo uma equipe por vez
 * (users.team_id). Supervisores e administradores nunca têm team_id: o vínculo
 * do supervisor com a equipe fica em teams.supervisor_id.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull(),
    teamId: uuid("team_id").references((): AnyPgColumn => teams.id, {
      onDelete: "restrict",
    }),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    index("users_team_idx").on(t.teamId),
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
    check("users_only_sellers_have_team", sql`${t.role} = 'SELLER' OR ${t.teamId} IS NULL`),
  ],
);

/**
 * Equipe comercial. Cada equipe tem no máximo um supervisor e cada supervisor
 * lidera no máximo uma equipe (índice único em supervisor_id).
 */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    supervisorId: uuid("supervisor_id").references((): AnyPgColumn => users.id, {
      onDelete: "restrict",
    }),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("teams_name_unique").on(sql`lower(${t.name})`),
    uniqueIndex("teams_supervisor_unique").on(t.supervisorId),
  ],
);

export type User = typeof users.$inferSelect;
export type Team = typeof teams.$inferSelect;
