import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import type { Database } from "./types";

/**
 * Fonte única do schema: os SQLs executados manualmente no Supabase
 * (database/migrations). O PGlite local/de testes aplica exatamente os mesmos
 * arquivos, então os testes validam o banco real.
 * (A pasta /drizzle é apenas histórico das migrations anteriores.)
 */
export const SQL_MIGRATIONS_FOLDER = path.join(process.cwd(), "database", "migrations");
export const DEFAULT_DATABASE_URL = "pglite://.data/pglite";

export type DatabaseHandle = {
  db: Database;
  driver: "postgres" | "pglite";
  /** Aplica database/migrations pendentes. Só existe de fato no PGlite. */
  migrate: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Abre a conexão conforme DATABASE_URL:
 * - postgres:// ou postgresql:// → PostgreSQL do Supabase (dev e produção).
 * - pglite://<diretório>          → Postgres embutido persistido em disco.
 * - pglite://memory              → Postgres embutido em memória (testes).
 */
export function connectDatabase(url: string = process.env.DATABASE_URL || DEFAULT_DATABASE_URL): DatabaseHandle {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new Pool({ connectionString: url, max: 10 });
    const db = drizzlePg(pool, { schema, casing: "snake_case" }) as unknown as Database;
    return {
      db,
      driver: "postgres",
      migrate: async () => {
        throw new Error("O schema do PostgreSQL remoto é aplicado manualmente (database/README.md).");
      },
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
      migrate: () => applySqlMigrations(client),
      close: () => client.close(),
    };
  }

  throw new Error("DATABASE_URL inválida: use postgres://... ou pglite://<diretório>");
}

async function applySqlMigrations(client: PGlite): Promise<void> {
  // Papéis que existem em todo projeto Supabase e que os scripts referenciam
  // (REVOKE ... FROM anon, authenticated). Controle local de execução fica
  // fora do schema public.
  await client.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS crm_local;
    CREATE TABLE IF NOT EXISTS crm_local.applied_migrations (
      name text PRIMARY KEY,
      applied_at timestamp with time zone NOT NULL DEFAULT now()
    );
  `);
  const { rows } = await client.query<{ name: string }>("SELECT name FROM crm_local.applied_migrations");
  const applied = new Set(rows.map((r) => r.name));

  const files = readdirSync(SQL_MIGRATIONS_FOLDER)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    await client.exec(readFileSync(path.join(SQL_MIGRATIONS_FOLDER, file), "utf8"));
    await client.query("INSERT INTO crm_local.applied_migrations (name) VALUES ($1)", [file]);
  }
}
