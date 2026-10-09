/**
 * Descreve para quem opera um script qual banco a DATABASE_URL aponta, SEM
 * expor credenciais: nunca devolve usuário, senha, host completo nem a URL.
 */
export type DatabaseTarget = { remote: boolean; lines: string[] };

export function describeDatabaseTarget(url: string): DatabaseTarget {
  if (url.startsWith("pglite://")) {
    return { remote: false, lines: ["Tipo: PGlite local (banco embutido neste computador)"] };
  }

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { remote: true, lines: ["Tipo: PostgreSQL remoto (DATABASE_URL não pôde ser interpretada)"] };
    }
    const host = parsed.hostname.toLowerCase();
    const isSupabase = host.endsWith(".supabase.com") || host.endsWith(".supabase.co");
    const provider = isSupabase ? `Supabase (${host.includes("pooler") ? "pooler" : "conexão direta"})` : "outro provedor";
    return {
      remote: true,
      lines: [
        "Tipo: PostgreSQL remoto",
        `Provedor: ${provider}`,
        `Porta: ${parsed.port || "5432"}`,
        `Banco: ${decodeURIComponent(parsed.pathname.slice(1)) || "postgres"}`,
        `SSL exigido na URL: ${/sslmode=(require|verify-ca|verify-full)/.test(parsed.search) ? "sim" : "não"}`,
      ],
    };
  }

  return { remote: false, lines: ["Tipo: desconhecido (DATABASE_URL inválida)"] };
}
