import { eq, is, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/server/db/schema";
import { auditEvents, teams, users } from "@/server/db/schema";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
});
afterAll(() => handle.close());

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await handle.db.execute(query)) as unknown as { rows: T[] }).rows;
}

describe("migrations (database/migrations, os mesmos SQLs executados no Supabase)", () => {
  it("são idempotentes (reaplicar não falha)", async () => {
    await expect(handle.migrate()).resolves.toBeUndefined();
  });

  it("criam as tabelas esperadas", async () => {
    const tables = await rows<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(tables.map((r) => r.table_name)).toEqual(["audit_events", "course_costs", "courses", "sessions", "teams", "users"]);
  });

  it("o schema Drizzle tem exatamente as mesmas colunas que o banco", async () => {
    const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));
    expect(tables.length).toBe(6);
    for (const table of tables) {
      const config = getTableConfig(table);
      const dbColumns = await rows<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${config.name}`,
      );
      expect(config.columns.map((c) => c.name).sort(), config.name).toEqual(dbColumns.map((c) => c.column_name).sort());
    }
  });

  it("Data API do Supabase bloqueada: RLS ligado e sem acesso para anon/authenticated", async () => {
    const rls = await rows<{ relname: string; relrowsecurity: boolean }>(
      sql`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );
    expect(rls.length).toBe(6);
    for (const table of rls) expect(table.relrowsecurity, table.relname).toBe(true);

    const grants = await rows<{ grantee: string }>(
      sql`select grantee from information_schema.role_table_grants
          where table_schema = 'public' and grantee in ('anon', 'authenticated')`,
    );
    expect(grants).toEqual([]);
  });
});

describe("integridade garantida pelo banco (defesa em profundidade)", () => {
  it("audit_events é append-only", async () => {
    await recordAudit(handle.db, { actorId: org.ids.admin, action: "user.updated", entityType: "user" });
    await expect(handle.db.update(auditEvents).set({ action: "adulterado" })).rejects.toThrow();
    await expect(handle.db.delete(auditEvents)).rejects.toThrow();
  });

  it("papel do usuário é imutável", async () => {
    await expect(handle.db.update(users).set({ role: "ADMIN" }).where(eq(users.id, org.ids.sellerA1))).rejects.toThrow();
  });

  it("apenas vendedores podem ter equipe", async () => {
    await expect(handle.db.update(users).set({ teamId: org.ids.teamA }).where(eq(users.id, org.ids.supB))).rejects.toThrow();
  });

  it("supervisor de equipe precisa ter papel SUPERVISOR", async () => {
    await expect(handle.db.update(teams).set({ supervisorId: org.ids.sellerA1 }).where(eq(teams.id, org.ids.teamA))).rejects.toThrow();
  });

  it("e-mail precisa estar normalizado em minúsculas", async () => {
    await expect(insertUser(handle, { name: "X", role: "ADMIN", email: "Maiusculo@Teste.Local" })).rejects.toThrow();
  });
});
