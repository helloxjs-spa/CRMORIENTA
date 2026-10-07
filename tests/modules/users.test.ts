import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents, users } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import {
  changeSellerTeam,
  createUser,
  getUser,
  listUsers,
  resetUserPassword,
  setUserActive,
  updateUser,
} from "@/server/modules/users/users.service";
import { createTestDatabase, seedOrganization } from "../support/db";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
});
afterAll(() => handle.close());

describe("vendedor não acessa recursos de outro vendedor", () => {
  it("não consegue listar usuários", async () => {
    await expect(listUsers(await org.ctx(org.ids.sellerA1))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("vê o próprio perfil", async () => {
    const me = await getUser(await org.ctx(org.ids.sellerA1), org.ids.sellerA1);
    expect(me.id).toBe(org.ids.sellerA1);
  });

  it("recebe NotFound ao trocar o ID para outro vendedor (mesma equipe ou não)", async () => {
    const ctx = await org.ctx(org.ids.sellerA1);
    await expect(getUser(ctx, org.ids.sellerA2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getUser(ctx, org.ids.sellerB1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getUser(ctx, org.ids.supA)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("não executa nenhuma operação administrativa", async () => {
    const ctx = await org.ctx(org.ids.sellerA1);
    await expect(updateUser(ctx, org.ids.sellerA2, { name: "Hack" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUserActive(ctx, org.ids.sellerA2, false)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resetUserPassword(ctx, org.ids.sellerA2, { password: "12345678" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(changeSellerTeam(ctx, org.ids.sellerA1, { teamId: org.ids.teamB })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("supervisor não acessa outra equipe", () => {
  it("lista apenas os vendedores da própria equipe", async () => {
    const list = await listUsers(await org.ctx(org.ids.supA));
    expect(list.map((u) => u.id).sort()).toEqual([org.ids.sellerA1, org.ids.sellerA2].sort());
  });

  it("filtro por outra equipe não fura o escopo", async () => {
    const list = await listUsers(await org.ctx(org.ids.supA), { teamId: org.ids.teamB });
    expect(list).toEqual([]);
  });

  it("vê vendedores da própria equipe e recebe NotFound para os de outra", async () => {
    const ctx = await org.ctx(org.ids.supA);
    await expect(getUser(ctx, org.ids.sellerA1)).resolves.toMatchObject({ id: org.ids.sellerA1 });
    await expect(getUser(ctx, org.ids.sellerB1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getUser(ctx, org.ids.supB)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("não cria usuários nem move vendedores", async () => {
    const ctx = await org.ctx(org.ids.supA);
    await expect(
      createUser(ctx, { name: "Novo", email: "novo@teste.local", password: "12345678", role: "SELLER", teamId: org.ids.teamA }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(changeSellerTeam(ctx, org.ids.sellerB1, { teamId: org.ids.teamA })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("administrador", () => {
  it("lista todos os usuários sem expor hash de senha", async () => {
    const list = await listUsers(await org.ctx(org.ids.admin));
    expect(list).toHaveLength(6);
    for (const user of list) expect(user).not.toHaveProperty("passwordHash");
  });

  it("cria vendedor em uma equipe e audita", async () => {
    const created = await createUser(await org.ctx(org.ids.admin), {
      name: "Vendedor Novo",
      email: "Novo.Vendedor@Teste.Local",
      password: "senha-forte-1",
      role: "SELLER",
      teamId: org.ids.teamB,
    });
    expect(created).toMatchObject({ email: "novo.vendedor@teste.local", teamId: org.ids.teamB, teamName: "Equipe B" });
    const [event] = await handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "user.created"), eq(auditEvents.entityId, created.id)));
    expect(event.actorId).toBe(org.ids.admin);
  });

  it("bloqueia e-mail duplicado", async () => {
    await expect(
      createUser(await org.ctx(org.ids.admin), { name: "Outro", email: "admin@teste.local", password: "12345678", role: "ADMIN" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("não permite supervisor/admin com equipe de vendedor", async () => {
    await expect(
      createUser(await org.ctx(org.ids.admin), {
        name: "Sup",
        email: "sup.x@teste.local",
        password: "12345678",
        role: "SUPERVISOR",
        teamId: org.ids.teamA,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("move vendedor de equipe e registra origem/destino", async () => {
    const ctx = await org.ctx(org.ids.admin);
    await changeSellerTeam(ctx, org.ids.sellerB1, { teamId: org.ids.teamA });
    const moved = await getUser(ctx, org.ids.sellerB1);
    expect(moved.teamId).toBe(org.ids.teamA);
    const [event] = await handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "user.team_changed"), eq(auditEvents.entityId, org.ids.sellerB1)));
    expect(event.metadata).toEqual({ fromTeamId: org.ids.teamB, toTeamId: org.ids.teamA });

    // O escopo do supervisor acompanha a mudança imediatamente.
    await expect(getUser(await org.ctx(org.ids.supA), org.ids.sellerB1)).resolves.toBeTruthy();
    await expect(getUser(await org.ctx(org.ids.supB), org.ids.sellerB1)).rejects.toBeInstanceOf(NotFoundError);
    await changeSellerTeam(ctx, org.ids.sellerB1, { teamId: org.ids.teamB });
  });

  it("não move supervisor como se fosse vendedor", async () => {
    await expect(changeSellerTeam(await org.ctx(org.ids.admin), org.ids.supA, { teamId: org.ids.teamB })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("não desativa a si mesmo nem supervisor que lidera equipe", async () => {
    const ctx = await org.ctx(org.ids.admin);
    await expect(setUserActive(ctx, org.ids.admin, false)).rejects.toBeInstanceOf(ValidationError);
    await expect(setUserActive(ctx, org.ids.supA, false)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("proteção contra mass assignment", () => {
  it("rejeita campos não previstos ao atualizar usuário (ex.: role, passwordHash, teamId)", async () => {
    const ctx = await org.ctx(org.ids.admin);
    for (const extra of [{ role: "ADMIN" }, { passwordHash: "x" }, { teamId: org.ids.teamB }, { active: false }]) {
      await expect(updateUser(ctx, org.ids.sellerA1, { name: "Nome", ...extra })).rejects.toBeInstanceOf(ValidationError);
    }
    const [row] = await handle.db.select().from(users).where(eq(users.id, org.ids.sellerA1));
    expect(row).toMatchObject({ role: "SELLER", teamId: org.ids.teamA, active: true, name: "Vendedor A1" });
  });

  it("rejeita campos extras na criação (ex.: id, active)", async () => {
    await expect(
      createUser(await org.ctx(org.ids.admin), {
        name: "X",
        email: "x@teste.local",
        password: "12345678",
        role: "SELLER",
        id: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejeita IDs malformados", async () => {
    await expect(getUser(await org.ctx(org.ids.admin), "1 OR 1=1")).rejects.toBeInstanceOf(ValidationError);
  });
});
