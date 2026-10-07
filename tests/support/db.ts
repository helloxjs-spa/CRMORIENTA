import { connectDatabase, type DatabaseHandle } from "@/server/db/connect";
import { hashPassword } from "@/server/auth/password";
import { loadActor } from "@/server/auth/session";
import { teams, users, type UserRole } from "@/server/db/schema";
import type { Actor } from "@/server/authz/actor";
import type { ServiceContext } from "@/server/context";

export const TEST_PASSWORD = "senha-de-teste-123";

/** Banco Postgres (PGlite) em memória com todas as migrations aplicadas. */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const handle = connectDatabase("pglite://memory");
  await handle.migrate();
  return handle;
}

let passwordHash: Promise<string> | undefined;

export async function insertUser(
  handle: DatabaseHandle,
  data: { name: string; role: UserRole; teamId?: string | null; active?: boolean; email?: string },
): Promise<string> {
  passwordHash ??= hashPassword(TEST_PASSWORD);
  const [row] = await handle.db
    .insert(users)
    .values({
      name: data.name,
      email: data.email ?? `${data.name.toLowerCase().replace(/\s+/g, ".")}@teste.local`,
      passwordHash: await passwordHash,
      role: data.role,
      teamId: data.teamId ?? null,
      active: data.active ?? true,
    })
    .returning({ id: users.id });
  return row.id;
}

/**
 * Estrutura mínima para testes de escopo:
 *   Equipe A (supervisor A) → vendedores A1, A2
 *   Equipe B (supervisor B) → vendedor B1
 */
export async function seedOrganization(handle: DatabaseHandle) {
  const admin = await insertUser(handle, { name: "Admin", role: "ADMIN" });
  const supA = await insertUser(handle, { name: "Supervisor A", role: "SUPERVISOR" });
  const supB = await insertUser(handle, { name: "Supervisor B", role: "SUPERVISOR" });
  const [teamA] = await handle.db.insert(teams).values({ name: "Equipe A", supervisorId: supA }).returning();
  const [teamB] = await handle.db.insert(teams).values({ name: "Equipe B", supervisorId: supB }).returning();
  const sellerA1 = await insertUser(handle, { name: "Vendedor A1", role: "SELLER", teamId: teamA.id });
  const sellerA2 = await insertUser(handle, { name: "Vendedor A2", role: "SELLER", teamId: teamA.id });
  const sellerB1 = await insertUser(handle, { name: "Vendedor B1", role: "SELLER", teamId: teamB.id });

  const ids = { admin, supA, supB, sellerA1, sellerA2, sellerB1, teamA: teamA.id, teamB: teamB.id };

  async function actor(userId: string): Promise<Actor> {
    const loaded = await loadActor(handle.db, userId);
    if (!loaded) throw new Error(`Usuário ${userId} não encontrado ou inativo`);
    return loaded;
  }

  async function ctx(userId: string): Promise<ServiceContext> {
    return { db: handle.db, actor: await actor(userId) };
  }

  return { ids, actor, ctx };
}
