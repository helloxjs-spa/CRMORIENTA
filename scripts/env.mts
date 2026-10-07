import { existsSync } from "node:fs";

/** Carrega .env (se existir) para scripts executados fora do Next.js. */
export function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}
