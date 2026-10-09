import { describe, expect, it } from "vitest";
import { describeDatabaseTarget } from "@/server/db/target";

describe("describeDatabaseTarget (o que o admin:create mostra antes de inserir)", () => {
  const url =
    "postgresql://postgres.abcdefghijklmnop:S3nh4-Sup3r-S3cr3t4@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require";

  it("identifica Supabase remoto sem revelar usuário, senha, projeto ou host", () => {
    const target = describeDatabaseTarget(url);
    expect(target.remote).toBe(true);
    expect(target.lines).toEqual([
      "Tipo: PostgreSQL remoto",
      "Provedor: Supabase (pooler)",
      "Porta: 5432",
      "Banco: postgres",
      "SSL exigido na URL: sim",
    ]);
    const printed = target.lines.join("\n");
    for (const secret of ["S3nh4", "abcdefghijklmnop", "aws-0-sa-east-1", "pooler.supabase.com", "postgres.", "@", "://"]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("conexão direta e outros provedores", () => {
    expect(describeDatabaseTarget("postgresql://u:p@db.xyz.supabase.co:5432/postgres").lines[1]).toBe("Provedor: Supabase (conexão direta)");
    expect(describeDatabaseTarget("postgres://u:p@example.com:6543/crm").lines).toContain("Provedor: outro provedor");
  });

  it("URL malformada não vaza o conteúdo", () => {
    const target = describeDatabaseTarget("postgresql://user:senha@@@:abc");
    expect(target.lines.join()).not.toContain("senha");
  });

  it("PGlite é local", () => {
    expect(describeDatabaseTarget("pglite://.data/pglite")).toEqual({
      remote: false,
      lines: ["Tipo: PGlite local (banco embutido neste computador)"],
    });
  });
});
