/** Apaga TODO o banco de desenvolvimento e recria a estrutura. Bloqueado em produção. */
import { rmSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.mjs";

loadEnv();

if (process.env.NODE_ENV === "production") {
  console.error("db:reset é bloqueado em produção.");
  process.exit(1);
}

const { connectDatabase, DEFAULT_DATABASE_URL } = await import("@/server/db/connect");
const { sql } = await import("drizzle-orm");
const url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

if (url.startsWith("pglite://")) {
  const dir = path.resolve(url.slice("pglite://".length));
  rmSync(dir, { recursive: true, force: true });
  console.log(`Diretório ${dir} removido.`);
} else {
  const handle = connectDatabase(url);
  await handle.db.execute(sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;`);
  await handle.close();
  console.log("Schemas public e drizzle recriados.");
}

const handle = connectDatabase(url);
await handle.migrate();
await handle.close();
console.log("Migrations reaplicadas. Rode `npm run db:seed` para dados fictícios.");
