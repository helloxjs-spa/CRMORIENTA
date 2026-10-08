import { defineConfig } from "drizzle-kit";

// LEGADO: a pasta /drizzle guarda o histórico das migrations geradas antes da
// adoção do Supabase. A fonte oficial do schema agora são os SQLs manuais em
// database/migrations (ver database/README.md). Este arquivo fica apenas para
// uso pontual do drizzle-kit (ex.: `npx drizzle-kit generate` como rascunho de
// SQL a ser revisado e copiado para um novo arquivo em database/migrations).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  strict: true,
  verbose: true,
});
