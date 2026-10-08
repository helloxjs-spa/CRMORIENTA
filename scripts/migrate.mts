/** Aplica as migrations do Drizzle no banco LOCAL (PGlite). Nunca no Supabase. */
import { assertLocalDatabase, loadEnv } from "./env.mjs";

loadEnv();
assertLocalDatabase("db:migrate");

const { connectDatabase } = await import("@/server/db/connect");
const handle = connectDatabase();
console.log(`Aplicando migrations (${handle.driver})...`);
await handle.migrate();
await handle.close();
console.log("Migrations aplicadas.");
