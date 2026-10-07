import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownedScope } from "@/server/authz/scope";
import type { DatabaseHandle } from "@/server/db/connect";
import { users } from "@/server/db/schema";
import { createTestDatabase, seedOrganization } from "../support/db";

/**
 * Valida o filtro SQL que leads, vendas, parcelas e certificados usarão nas
 * próximas fases. Como esses módulos ainda não existem, usamos a tabela users
 * como "recurso com dono": ownerId = users.id, teamId = users.team_id.
 */
let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
});
afterAll(() => handle.close());

async function visibleIds(userId: string, extra?: ReturnType<typeof eq>) {
  const actor = await org.actor(userId);
  const rows = await handle.db
    .select({ id: users.id })
    .from(users)
    .where(and(ownedScope(actor, { ownerId: users.id, teamId: users.teamId }), extra));
  return rows.map((r) => r.id).sort();
}

describe("ownedScope em SQL", () => {
  it("vendedor só enxerga o próprio registro", async () => {
    expect(await visibleIds(org.ids.sellerA1)).toEqual([org.ids.sellerA1]);
  });

  it("buscar por ID de outro vendedor não retorna nada (IDOR)", async () => {
    expect(await visibleIds(org.ids.sellerA1, eq(users.id, org.ids.sellerB1))).toEqual([]);
    expect(await visibleIds(org.ids.sellerA1, eq(users.id, org.ids.sellerA2))).toEqual([]);
  });

  it("supervisor enxerga apenas registros da própria equipe", async () => {
    expect(await visibleIds(org.ids.supA)).toEqual([org.ids.sellerA1, org.ids.sellerA2].sort());
    expect(await visibleIds(org.ids.supA, eq(users.id, org.ids.sellerB1))).toEqual([]);
  });

  it("administrador enxerga tudo", async () => {
    expect(await visibleIds(org.ids.admin)).toHaveLength(6);
  });
});
