import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
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

describe("migrations", () => {
  it("são idempotentes (reaplicar não falha)", async () => {
    await expect(handle.migrate()).resolves.toBeUndefined();
  });

  it("criam as tabelas da fundação", async () => {
    const { rows } = (await handle.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    )) as unknown as { rows: { table_name: string }[] };
    expect(rows.map((r) => r.table_name)).toEqual(["audit_events", "sessions", "teams", "users"]);
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
