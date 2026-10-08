import { existsSync } from "node:fs";

/** Carrega .env (se existir) para scripts executados fora do Next.js. */
export function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

/**
 * Alterações de schema no Supabase são SEMPRE manuais (database/README.md).
 * Scripts que mexem em estrutura só podem rodar contra o PGlite local.
 * Nunca imprime a DATABASE_URL.
 */
export function assertLocalDatabase(script: string): void {
  const url = process.env.DATABASE_URL ?? "";
  if (url && !url.startsWith("pglite://")) {
    console.error(
      `${script} só roda contra o banco local (pglite://). ` +
        "A DATABASE_URL aponta para um PostgreSQL remoto: aplique os SQLs de database/migrations manualmente no SQL Editor do Supabase.",
    );
    process.exit(1);
  }
}
