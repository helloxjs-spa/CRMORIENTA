import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { connectDatabase, SQL_MIGRATIONS_FOLDER, type DatabaseHandle } from "@/server/db/connect";
import { AppError } from "@/server/errors";

/**
 * PostgreSQL REAL, local e descartável, para testes de concorrência (o PGlite
 * tem uma única conexão e não reproduz disputa de travas).
 *
 * Só é usado quando CRM_TEST_PG_URL aponta para um servidor em 127.0.0.1 /
 * localhost (ex.: postgresql://postgres@127.0.0.1:55432/postgres). Nunca lê
 * DATABASE_URL nem .env. Cada arquivo de teste cria um banco crm_conc_<aleatório>,
 * aplica database/migrations e o apaga no fim.
 */
export const REAL_PG_URL = process.env.CRM_TEST_PG_URL;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function assertLocal(url: string): URL {
  const parsed = new URL(url);
  if (!/^postgres(ql)?:$/.test(parsed.protocol) || !LOOPBACK.has(parsed.hostname) || /supabase/i.test(url)) {
    throw new Error("CRM_TEST_PG_URL recusada: use apenas um PostgreSQL local (127.0.0.1/localhost).");
  }
  return parsed;
}

export type RealPgDatabase = {
  name: string;
  url: string;
  handle: DatabaseHandle;
  /** Nova conexão avulsa (sessão própria) no banco de teste. */
  client: (app?: string) => Promise<Client>;
  drop: () => Promise<void>;
};

/** Arquivos de database/migrations, na ordem. */
export function migrationFiles(): string[] {
  return readdirSync(SQL_MIGRATIONS_FOLDER).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
}

/** Executa um arquivo de migration numa conexão própria (o próprio arquivo abre e fecha a transação). */
export async function runMigrationFile(client: Client, file: string): Promise<void> {
  await client.query(readFileSync(path.join(SQL_MIGRATIONS_FOLDER, file), "utf8"));
}

/** `lastMigration`: aplica só até este arquivo (ex.: "003_sales.sql"); padrão: todos. */
export async function createRealPgDatabase(options: { lastMigration?: string } = {}): Promise<RealPgDatabase> {
  const server = assertLocal(REAL_PG_URL!);
  const name = `crm_conc_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: server.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;`);
  } finally {
    await admin.end();
  }

  const target = new URL(server.toString());
  target.pathname = `/${name}`;
  const url = target.toString();

  const client = async (app = "crm-test") => {
    const c = new Client({ connectionString: url, application_name: app });
    await c.connect();
    return c;
  };

  // Os MESMOS arquivos executados no Supabase, na ordem.
  const migrator = await client("crm-test-migrate");
  try {
    for (const file of migrationFiles()) {
      if (options.lastMigration && file > options.lastMigration) break;
      await runMigrationFile(migrator, file);
    }
  } finally {
    await migrator.end();
  }

  const handle = connectDatabase(url);
  return {
    name,
    url,
    handle,
    client,
    drop: async () => {
      await handle.close();
      const c = new Client({ connectionString: server.toString() });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

/** Espera (por consulta ao servidor, sem atraso fixo) até `predicate` valer. */
export async function waitUntil(predicate: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`tempo esgotado esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export type Outcome = { ok: true } | { ok: false; error: unknown };
export type Tracked = { promise: Promise<Outcome>; settled: () => boolean };

/** Acompanha uma operação concorrente sem deixar a rejeição escapar. */
export function track(promise: Promise<unknown>): Tracked {
  let done = false;
  const settledPromise = promise.then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  void settledPromise.finally(() => (done = true));
  return { promise: settledPromise, settled: () => done };
}

export function sqlState(error: unknown): string | undefined {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** "ok", o nome do erro de domínio ou o SQLSTATE do banco. */
export function outcomeName(outcome: Outcome): string {
  if (outcome.ok) return "ok";
  return outcome.error instanceof AppError ? outcome.error.name : `SQLSTATE ${sqlState(outcome.error) ?? "?"}`;
}

/** Sessão "portão": abre transação e segura a trava pedida até `release`. */
export async function gate(
  db: RealPgDatabase,
  lockSql: string,
  params: unknown[] = [],
): Promise<{ pid: number; release: () => Promise<void> }> {
  const c = await db.client("crm-test-gate");
  const { rows } = await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  await c.query("BEGIN");
  await c.query(lockSql, params);
  return {
    pid: rows[0].pid,
    release: async () => {
      await c.query("ROLLBACK");
      await c.end();
    },
  };
}

/** Sessões deste banco esperando trava, com quem as bloqueia. */
export async function lockWaiters(monitor: Client): Promise<{ pid: number; blockedBy: number[] }[]> {
  const { rows } = await monitor.query<{ pid: number; blocked_by: number[] }>(
    `SELECT pid, pg_blocking_pids(pid) AS blocked_by
       FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return rows.map((r) => ({ pid: r.pid, blockedBy: r.blocked_by }));
}
