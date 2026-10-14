import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents, leadEvents, leads, teams, users } from "@/server/db/schema";
import { ValidationError } from "@/server/errors";
import {
  createLead,
  getLead,
  OWN_TEAM_INACTIVE,
  redistributeLead,
  restoreLead,
  TARGET_TEAM_INACTIVE,
  transferLead,
  trashLead,
} from "@/server/modules/leads/leads.service";
import { updateTeam } from "@/server/modules/teams/teams.service";
import { changeSellerTeam, SELLER_TEAM_INACTIVE, setUserActive } from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourse, setLeadStage } from "../support/leads";

/**
 * Regra confirmada: equipe INATIVA não tem vendedor reativado nem vendedor
 * recebendo leads novos; nada histórico é alterado. Regularização: reativar a
 * equipe ou transferir o vendedor para uma equipe ativa.
 * (A disputa concorrente com a desativação da equipe é testada em PostgreSQL
 * real, tests/concurrency/teams-locking.pg.test.ts.)
 */

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let courseId: string;
let seq = 0;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  courseId = await insertCourse(handle, "Pedagogia");
});
afterAll(() => handle.close());

const nextPhone = () => `(79) 96${String(++seq).padStart(7, "0")}`;
const admin = () => org.ctx(org.ids.admin);

async function newTeam(name: string): Promise<string> {
  const supervisor = await insertUser(handle, { name: `Sup ${name}`, role: "SUPERVISOR" });
  const [team] = await handle.db.insert(teams).values({ name, supervisorId: supervisor }).returning({ id: teams.id });
  return team.id;
}

const eventTypes = async (leadId: string) =>
  (await handle.db.select({ type: leadEvents.type }).from(leadEvents).where(eq(leadEvents.leadId, leadId)).orderBy(asc(leadEvents.id))).map(
    (e) => e.type,
  );
const leadRow = async (leadId: string) => (await handle.db.select().from(leads).where(eq(leads.id, leadId)))[0];
const userRow = async (id: string) => (await handle.db.select().from(users).where(eq(users.id, id)))[0];

/**
 * Vendedor ATIVO numa equipe INATIVA: com a regra nova esse estado não é
 * mais produzido pelos serviços, mas pode existir em dados anteriores.
 */
async function legacyActiveSellerInInactiveTeam(name: string): Promise<{ teamId: string; sellerId: string; leadId: string }> {
  const teamId = await newTeam(`Equipe ${name}`);
  const sellerId = await insertUser(handle, { name: `Vendedor ${name}`, role: "SELLER", teamId });
  const lead = await createLead(await org.ctx(sellerId), { name: "Lead Histórico", phone: nextPhone(), interestCourseId: courseId });
  await handle.db.update(teams).set({ active: false }).where(eq(teams.id, teamId));
  return { teamId, sellerId, leadId: lead.id };
}

describe("reativação de vendedor de equipe inativa", () => {
  it("é recusada; o vendedor continua inativo e nada é auditado", async () => {
    const teamId = await newTeam("Equipe Encerrada");
    const seller = await insertUser(handle, { name: "Vendedor Encerrado", role: "SELLER", teamId });
    await setUserActive(await admin(), seller, false);
    await updateTeam(await admin(), teamId, { active: false });

    const error = await setUserActive(await admin(), seller, true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe(SELLER_TEAM_INACTIVE);
    expect((await userRow(seller)).active).toBe(false);
    const activated = await handle.db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, seller), eq(auditEvents.action, "user.activated")));
    expect(activated).toEqual([]);
  });

  it("é permitida depois de reativar a equipe", async () => {
    const teamId = await newTeam("Equipe Reaberta");
    const seller = await insertUser(handle, { name: "Vendedor Reaberto", role: "SELLER", teamId });
    await setUserActive(await admin(), seller, false);
    await updateTeam(await admin(), teamId, { active: false });
    await updateTeam(await admin(), teamId, { active: true });

    await setUserActive(await admin(), seller, true);
    expect((await userRow(seller)).active).toBe(true);
  });

  it("é permitida depois de transferir o vendedor para uma equipe ativa", async () => {
    const teamId = await newTeam("Equipe Fechada");
    const seller = await insertUser(handle, { name: "Vendedor Transferido", role: "SELLER", teamId });
    await setUserActive(await admin(), seller, false);
    await updateTeam(await admin(), teamId, { active: false });
    await changeSellerTeam(await admin(), seller, { teamId: org.ids.teamA });

    await setUserActive(await admin(), seller, true);
    expect(await userRow(seller)).toMatchObject({ active: true, teamId: org.ids.teamA });
  });

  it("vendedor de equipe ATIVA continua sendo reativado normalmente", async () => {
    const seller = await insertUser(handle, { name: "Vendedor Comum", role: "SELLER", teamId: org.ids.teamB });
    await setUserActive(await admin(), seller, false);
    await setUserActive(await admin(), seller, true);
    expect((await userRow(seller)).active).toBe(true);
  });
});

describe("leads novos para vendedor de equipe inativa", () => {
  it("cadastro pelo próprio vendedor é recusado", async () => {
    const legacy = await legacyActiveSellerInInactiveTeam("Cadastro");
    const phone = nextPhone();
    const error = await createLead(await org.ctx(legacy.sellerId), { name: "Novo", phone, interestCourseId: courseId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe(OWN_TEAM_INACTIVE);
    expect(await handle.db.select().from(leads).where(eq(leads.phone, `55${phone.replace(/\D/g, "")}`))).toEqual([]);
  });

  it("transferência para ele é recusada; o lead e o histórico ficam iguais", async () => {
    const legacy = await legacyActiveSellerInInactiveTeam("Transferência");
    const lead = await createLead(await org.ctx(org.ids.sellerA1), { name: "Ana", phone: nextPhone(), interestCourseId: courseId });
    const before = await leadRow(lead.id);

    const error = await transferLead(await admin(), lead.id, { toSellerId: legacy.sellerId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fieldErrors).toEqual({ toSellerId: [TARGET_TEAM_INACTIVE] });
    expect(await leadRow(lead.id)).toEqual(before);
    expect(await eventTypes(lead.id)).toEqual(["CREATED"]);
  });

  it("redistribuição para ele é recusada", async () => {
    const legacy = await legacyActiveSellerInInactiveTeam("Redistribuição");
    const lead = await createLead(await org.ctx(org.ids.sellerA1), { name: "Bia", phone: nextPhone(), interestCourseId: courseId });
    await setLeadStage(handle, lead.id, "FOLLOW_UP_3", -1);

    await expect(redistributeLead(await admin(), lead.id, { toSellerId: legacy.sellerId })).rejects.toBeInstanceOf(ValidationError);
    expect(await leadRow(lead.id)).toMatchObject({ ownerId: org.ids.sellerA1, stage: "FOLLOW_UP_3" });
    expect(await eventTypes(lead.id)).toEqual(["CREATED"]);
  });

  it("recuperação da Lixeira para ele é recusada; o lead continua na Lixeira", async () => {
    const legacy = await legacyActiveSellerInInactiveTeam("Recuperação");
    const lead = await createLead(await org.ctx(org.ids.sellerA1), { name: "Caio", phone: nextPhone(), interestCourseId: courseId });
    await trashLead(await admin(), lead.id);

    await expect(restoreLead(await admin(), lead.id, { toSellerId: legacy.sellerId })).rejects.toBeInstanceOf(ValidationError);
    expect(await leadRow(lead.id)).toMatchObject({ status: "TRASHED" });
    expect(await eventTypes(lead.id)).toEqual(["CREATED", "TRASHED"]);
  });

  it("os leads e eventos que ele já tinha não são alterados", async () => {
    const legacy = await legacyActiveSellerInInactiveTeam("Histórico");
    const before = await leadRow(legacy.leadId);
    const eventsBefore = await eventTypes(legacy.leadId);

    // Tentativas bloqueadas não mexem no histórico.
    await createLead(await org.ctx(legacy.sellerId), { name: "X", phone: nextPhone(), interestCourseId: courseId }).catch(() => {});
    await setUserActive(await admin(), legacy.sellerId, true).catch(() => {});

    expect(await leadRow(legacy.leadId)).toEqual(before);
    expect(before).toMatchObject({ ownerId: legacy.sellerId, teamId: legacy.teamId, status: "ACTIVE" });
    expect(await eventTypes(legacy.leadId)).toEqual(eventsBefore);
    expect((await getLead(await admin(), legacy.leadId)).ownerId).toBe(legacy.sellerId);
  });

  it("transferência para vendedor de equipe ATIVA continua funcionando", async () => {
    const lead = await createLead(await org.ctx(org.ids.sellerA1), { name: "Duda", phone: nextPhone(), interestCourseId: courseId });
    await transferLead(await admin(), lead.id, { toSellerId: org.ids.sellerB1 });
    expect(await leadRow(lead.id)).toMatchObject({ ownerId: org.ids.sellerB1, teamId: org.ids.teamB });
  });
});
