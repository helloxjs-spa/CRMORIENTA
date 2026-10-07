import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import {
  createTeam,
  getMyTeam,
  getTeam,
  listAvailableSupervisors,
  listTeams,
  setTeamSupervisor,
  updateTeam,
} from "@/server/modules/teams/teams.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
});
afterAll(() => handle.close());

describe("escopo de equipes", () => {
  it("vendedor não acessa equipes", async () => {
    const ctx = await org.ctx(org.ids.sellerA1);
    await expect(listTeams(ctx)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getTeam(ctx, org.ids.teamA)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("supervisor lista apenas a própria equipe, com contagem de vendedores", async () => {
    const list = await listTeams(await org.ctx(org.ids.supA));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: org.ids.teamA, supervisorName: "Supervisor A", sellerCount: 2 });
  });

  it("supervisor vê os membros da própria equipe", async () => {
    const team = await getTeam(await org.ctx(org.ids.supA), org.ids.teamA);
    expect(team.members.map((m) => m.id).sort()).toEqual([org.ids.sellerA1, org.ids.sellerA2].sort());
  });

  it("supervisor recebe NotFound ao acessar outra equipe pelo ID", async () => {
    await expect(getTeam(await org.ctx(org.ids.supA), org.ids.teamB)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("supervisor não altera equipes", async () => {
    const ctx = await org.ctx(org.ids.supA);
    await expect(updateTeam(ctx, org.ids.teamA, { name: "Renomeada" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setTeamSupervisor(ctx, org.ids.teamB, { supervisorId: org.ids.supA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createTeam(ctx, { name: "Nova" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("getMyTeam devolve apenas a equipe do próprio usuário, sem membros", async () => {
    const sellerTeam = await getMyTeam(await org.ctx(org.ids.sellerB1));
    expect(sellerTeam).toMatchObject({ id: org.ids.teamB, supervisorName: "Supervisor B" });
    expect(sellerTeam).not.toHaveProperty("members");
    expect(await getMyTeam(await org.ctx(org.ids.supA))).toMatchObject({ id: org.ids.teamA });
    expect(await getMyTeam(await org.ctx(org.ids.admin))).toBeNull();
  });

  it("administrador vê todas as equipes", async () => {
    const list = await listTeams(await org.ctx(org.ids.admin));
    expect(list.map((t) => t.name)).toEqual(["Equipe A", "Equipe B"]);
  });
});

describe("gestão de equipes (administrador)", () => {
  it("cria equipe com supervisor disponível", async () => {
    const ctx = await org.ctx(org.ids.admin);
    const supC = await insertUser(handle, { name: "Supervisor C", role: "SUPERVISOR" });
    expect((await listAvailableSupervisors(ctx)).map((s) => s.id)).toContain(supC);

    const team = await createTeam(ctx, { name: "Equipe C", supervisorId: supC });
    expect(team).toMatchObject({ name: "Equipe C", supervisorId: supC, supervisorName: "Supervisor C" });
    expect((await listAvailableSupervisors(ctx)).map((s) => s.id)).not.toContain(supC);

    // O novo supervisor passa a enxergar somente a nova equipe.
    const visible = await listTeams(await org.ctx(supC));
    expect(visible.map((t) => t.id)).toEqual([team.id]);
  });

  it("nome de equipe é único sem diferenciar maiúsculas", async () => {
    await expect(createTeam(await org.ctx(org.ids.admin), { name: "equipe a" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("supervisor não pode liderar duas equipes", async () => {
    await expect(createTeam(await org.ctx(org.ids.admin), { name: "Equipe D", supervisorId: org.ids.supA })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("somente usuário SUPERVISOR pode ser supervisor", async () => {
    await expect(
      setTeamSupervisor(await org.ctx(org.ids.admin), org.ids.teamA, { supervisorId: org.ids.sellerA1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("troca de supervisor muda o escopo imediatamente", async () => {
    const ctx = await org.ctx(org.ids.admin);
    const supE = await insertUser(handle, { name: "Supervisor E", role: "SUPERVISOR" });
    const team = await createTeam(ctx, { name: "Equipe E" });
    await setTeamSupervisor(ctx, team.id, { supervisorId: supE });
    await expect(getTeam(await org.ctx(supE), team.id)).resolves.toMatchObject({ id: team.id });

    await setTeamSupervisor(ctx, team.id, { supervisorId: null });
    await expect(getTeam(await org.ctx(supE), team.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listTeams(await org.ctx(supE))).toEqual([]);
  });

  it("não inativa equipe com vendedores ativos", async () => {
    await expect(updateTeam(await org.ctx(org.ids.admin), org.ids.teamA, { active: false })).rejects.toBeInstanceOf(ConflictError);
  });

  it("criações simultâneas com o mesmo nome: apenas uma vence", async () => {
    const ctx = await org.ctx(org.ids.admin);
    const results = await Promise.allSettled([createTeam(ctx, { name: "Concorrente" }), createTeam(ctx, { name: "CONCORRENTE" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
  });

  it("rejeita campos não previstos (mass assignment)", async () => {
    await expect(
      updateTeam(await org.ctx(org.ids.admin), org.ids.teamA, { name: "X Y", supervisorId: org.ids.supB }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
