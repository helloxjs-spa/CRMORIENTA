import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { leadEvents, leads, teams, users } from "@/server/db/schema";
import { NotFoundError, UnauthenticatedError, ValidationError } from "@/server/errors";
import { createLead, editLead, transferLead } from "@/server/modules/leads/leads.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourse } from "../support/leads";

/**
 * Revalidação depois das travas (lockLeadForChange): o Actor é carregado no
 * início da requisição, mas a decisão usa o que está travado no banco.
 * (A disputa concorrente em si é testada em PostgreSQL real, tests/concurrency.)
 */

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let courseId: string;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  courseId = await insertCourse(handle, "Pedagogia");
});
afterAll(() => handle.close());

let phoneSeq = 0;
const nextPhone = () => `(79) 97${String(++phoneSeq).padStart(7, "0")}`;

async function newLead(sellerId: string) {
  return createLead(await org.ctx(sellerId), { name: "Maria Souza", phone: nextPhone(), interestCourseId: courseId });
}

const eventTypes = async (leadId: string) =>
  (await handle.db.select({ type: leadEvents.type }).from(leadEvents).where(eq(leadEvents.leadId, leadId)).orderBy(asc(leadEvents.id))).map(
    (e) => e.type,
  );

describe("revalidação do ator depois das travas", () => {
  it("SUPERVISOR que deixou de liderar a equipe (Actor da requisição desatualizado) → fora do escopo, nada gravado", async () => {
    const supervisor = await insertUser(handle, { name: "Supervisor Saindo", role: "SUPERVISOR" });
    const [team] = await handle.db.insert(teams).values({ name: "Equipe Saindo", supervisorId: supervisor }).returning();
    const seller = await insertUser(handle, { name: "Vendedor Saindo", role: "SELLER", teamId: team.id });
    const other = await insertUser(handle, { name: "Outro Saindo", role: "SELLER", teamId: team.id });
    const lead = await newLead(seller);
    const staleCtx = await org.ctx(supervisor);

    await handle.db.update(teams).set({ supervisorId: null }).where(eq(teams.id, team.id));

    await expect(transferLead(staleCtx, lead.id, { toSellerId: other })).rejects.toBeInstanceOf(NotFoundError);
    const [row] = await handle.db.select({ ownerId: leads.ownerId }).from(leads).where(eq(leads.id, lead.id));
    expect(row.ownerId).toBe(seller);
    expect(await eventTypes(lead.id)).toEqual(["CREATED"]);
  });

  it("ator desativado depois de carregado → sessão encerrada, nada gravado", async () => {
    const supervisor = await insertUser(handle, { name: "Supervisor Desligado", role: "SUPERVISOR" });
    const [team] = await handle.db.insert(teams).values({ name: "Equipe Desligado", supervisorId: supervisor }).returning();
    const seller = await insertUser(handle, { name: "Vendedor Desligado", role: "SELLER", teamId: team.id });
    const lead = await newLead(seller);
    const staleCtx = await org.ctx(supervisor);

    await handle.db.update(users).set({ active: false }).where(eq(users.id, supervisor));

    await expect(editLead(staleCtx, lead.id, { name: "Nome Novo" })).rejects.toBeInstanceOf(UnauthenticatedError);
    const [row] = await handle.db.select({ name: leads.name }).from(leads).where(eq(leads.id, lead.id));
    expect(row.name).toBe("Maria Souza");
    expect(await eventTypes(lead.id)).toEqual(["CREATED"]);
  });

  it("vendedor de destino inexistente continua sendo recusado como antes (sem erro de banco)", async () => {
    const lead = await newLead(org.ids.sellerA1);
    await expect(
      transferLead(await org.ctx(org.ids.supA), lead.id, { toSellerId: "00000000-0000-4000-8000-000000000999" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
