import { defineConfig } from "drizzle-kit";

// drizzle-kit é usado apenas para GERAR migrations SQL a partir do schema.
// A aplicação delas é feita por scripts/migrate.ts (funciona com Postgres e PGlite).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  strict: true,
  verbose: true,
});
