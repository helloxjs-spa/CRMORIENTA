import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Tipo comum ao Postgres (node-postgres) e ao PGlite. Transações do Drizzle
 * também satisfazem este tipo, então serviços podem receber `db` ou `tx`.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
