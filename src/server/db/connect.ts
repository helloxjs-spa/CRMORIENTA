import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import type { Database } from "./types";

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");
export const DEFAULT_DATABASE_URL = "pglite://.data/pglite";

export type DatabaseHandle = {
  db: Database;
  driver: "postgres" | "pglite";
  migrate: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Abre a conexão conforme DATABASE_URL:
 * - postgres:// ou postgresql:// → PostgreSQL real (produção).
 * - pglite://<diretório>          → Postgres embutido persistido em disco (dev).
 * - pglite://memory              → Postgres embutido em memória (testes).
 */
export function connectDatabase(url: string = process.env.DATABASE_URL || DEFAULT_DATABASE_URL): DatabaseHandle {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new Pool({ connectionString: url, max: 10 });
    const db = drizzlePg(pool, { schema, casing: "snake_case" }) as unknown as Database;
    return {
      db,
      driver: "postgres",
      migrate: () => migratePg(drizzlePg(pool), { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => pool.end(),
    };
  }

  if (url.startsWith("pglite://")) {
    const location = url.slice("pglite://".length);
    let client: PGlite;
    if (location === "memory") {
      client = new PGlite();
    } else {
      const dir = path.resolve(location);
      mkdirSync(dir, { recursive: true });
      client = new PGlite(dir);
    }
    const db = drizzlePglite(client, { schema, casing: "snake_case" }) as unknown as Database;
    return {
      db,
      driver: "pglite",
      migrate: () => migratePglite(drizzlePglite(client), { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => client.close(),
    };
  }

  throw new Error(`DATABASE_URL inválida: use postgres://... ou pglite://<diretório>`);
}
