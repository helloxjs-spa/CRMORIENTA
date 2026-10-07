import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./organization";

/**
 * Sessões de login. O cookie carrega um token aleatório; o banco guarda apenas
 * o SHA-256 dele (id), de modo que um vazamento da tabela não permite sequestrar
 * sessões.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export type Session = typeof sessions.$inferSelect;
