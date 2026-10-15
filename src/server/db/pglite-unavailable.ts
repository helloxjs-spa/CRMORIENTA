/**
 * Substitui @electric-sql/pglite no build da Cloudflare (ver next.config.ts):
 * o Worker só fala com o PostgreSQL do Supabase (Hyperdrive), e o PGlite
 * (WASM, sistema de arquivos) não deve ir para o pacote. Exporta apenas o que
 * drizzle-orm/pglite importa; usar falha com mensagem clara.
 */
export class PGlite {
  constructor() {
    throw new Error("PGlite não está disponível no build da Cloudflare. Use o PostgreSQL (binding HYPERDRIVE).");
  }
}

export const types = {};
