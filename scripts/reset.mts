/** Apaga o banco LOCAL (PGlite) e recria a estrutura. Nunca roda contra o Supabase. */
import { rmSync } from "node:fs";
import path from "node:path";
import { assertLocalDatabase, loadEnv } from "./env.mjs";

loadEnv();
assertLocalDatabase("db:reset");

if (process.env.NODE_ENV === "production") {
  console.error("db:reset é bloqueado em produção.");
  process.exit(1);
}

const { connectDatabase, DEFAULT_DATABASE_URL } = await import("@/server/db/connect");
const url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

const dir = path.resolve(url.slice("pglite://".length));
rmSync(dir, { recursive: true, force: true });
console.log(`Diretório ${dir} removido.`);

const handle = connectDatabase(url);
await handle.migrate();
await handle.close();
console.log("Migrations reaplicadas. Rode `npm run db:seed` para dados fictícios.");
