import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BRAZILIAN_DDDS, parseBrazilianPhone } from "@/lib/phone";
import type { DatabaseHandle } from "@/server/db/connect";
import { leadCycles, leadEvents, leadNotes, leads, users } from "@/server/db/schema";
import { createLead } from "@/server/modules/leads/leads.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourse } from "../support/leads";

/**
 * Regras de Leads garantidas pelo PRÓPRIO banco (database/migrations/002),
 * independentemente do código da aplicação.
 */

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let courseId: string;
let lead: { id: string; cycleId: string };

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  courseId = await insertCourse(handle);
  const created = await createLead(await org.ctx(org.ids.sellerA1), { name: "Maria", phone: "79 99999-0001", interestCourseId: courseId });
  const [cycle] = await handle.db.select({ id: leadCycles.id }).from(leadCycles).where(eq(leadCycles.leadId, created.id));
  lead = { id: created.id, cycleId: cycle.id };
});
afterAll(() => handle.close());

/** Insert direto (sem o serviço), para provar que o banco recusa sozinho. */
function rawInsert(phone: string, ownerId = org.ids.sellerA1, teamId = org.ids.teamA) {
  return handle.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(leads)
      .values({ name: "Direto", phone, interestCourseId: courseId, ownerId, teamId, createdBy: ownerId })
      .returning({ id: leads.id });
    await tx.insert(leadCycles).values({ leadId: row.id, number: 1, kind: "INITIAL", assignedSellerId: ownerId, teamId, startedBy: ownerId });
  });
}

/** Mensagem do erro do Postgres (o Drizzle encapsula o erro do driver em `cause`). */
async function dbError(promise: Promise<unknown>): Promise<string> {
  const error = (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as { message?: string; cause?: { message?: string } } | null;
  expect(error, "o banco deveria ter recusado").not.toBeNull();
  return `${error?.message ?? ""} ${error?.cause?.message ?? ""}`;
}

describe("telefone", () => {
  it("a lista de DDDs do código é a mesma do CHECK do banco", async () => {
    const [{ def }] = (
      (await handle.db.execute(
        sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'leads_phone_canonical'`,
      )) as unknown as { rows: { def: string }[] }
    ).rows;
    const regex = def.match(/'(\^55.*\$)'/)![1];

    const candidates: string[] = [];
    for (let ddd = 10; ddd <= 99; ddd++) candidates.push(`55${ddd}987654321`, `55${ddd}32110000`);
    const result = (await handle.db.execute(
      sql`select phone, phone ~ ${regex} as ok from unnest(${`{${candidates.join(",")}}`}::text[]) as phone`,
    )) as unknown as { rows: { phone: string; ok: boolean }[] };

    for (const { phone, ok } of result.rows) {
      const appAccepts = parseBrazilianPhone(phone).ok;
      expect(ok, phone).toBe(appAccepts);
      expect(ok, phone).toBe((BRAZILIAN_DDDS as readonly number[]).includes(Number(phone.slice(2, 4))));
    }
  });

  it("formato não canônico é recusado pelo banco", async () => {
    for (const phone of ["79999990001", "(79) 99999-0001", "557999990001", "5520999990001"]) {
      expect(await dbError(rawInsert(phone))).toContain("leads_phone_canonical");
    }
  });

  it("telefone duplicado é recusado pelo banco, mesmo com o lead na Lixeira", async () => {
    expect(await dbError(rawInsert("5579999990001", org.ids.sellerB1, org.ids.teamB))).toContain("leads_phone_unique");
    await handle.db.transaction(async (tx) => {
      await tx.update(leadCycles).set({ endedAt: sql`now()`, endedBy: org.ids.supA, endReason: "TRASHED" }).where(eq(leadCycles.id, lead.cycleId));
      await tx.update(leads).set({ status: "TRASHED", trashedAt: sql`now()`, trashedBy: org.ids.supA }).where(eq(leads.id, lead.id));
    });
    expect(await dbError(rawInsert("5579999990001", org.ids.sellerB1, org.ids.teamB))).toContain("leads_phone_unique");
  });
});

describe("responsável e equipe", () => {
  it("responsável precisa ser SELLER ativo da mesma equipe", async () => {
    expect(await dbError(rawInsert("5579999990010", org.ids.supA))).toContain("SELLER");
    expect(await dbError(rawInsert("5579999990011", org.ids.sellerA1, org.ids.teamB))).toContain("equipe atual");
  });

  it("desativar vendedor sem tirar os leads em operação falha no COMMIT", async () => {
    await rawInsert("5579999990012", org.ids.sellerA2);
    expect(await dbError(handle.db.update(users).set({ active: false }).where(eq(users.id, org.ids.sellerA2)))).toContain(
      "leads em operação",
    );
  });

  it("mudar o vendedor de equipe sem levar os leads falha no COMMIT", async () => {
    expect(await dbError(handle.db.update(users).set({ teamId: org.ids.teamB }).where(eq(users.id, org.ids.sellerA2)))).toContain(
      "leads em operação",
    );
  });
});

describe("ciclos", () => {
  it("lead sem ciclo é recusado no COMMIT", async () => {
    expect(
      await dbError(
        handle.db.insert(leads).values({
          name: "Sem ciclo",
          phone: "5579999990020",
          interestCourseId: courseId,
          ownerId: org.ids.sellerA1,
          teamId: org.ids.teamA,
          createdBy: org.ids.sellerA1,
        }),
      ),
    ).toContain("sem ciclo");
  });

  it("lead em operação não pode ficar sem ciclo aberto; dois ciclos abertos são recusados", async () => {
    const [open] = await handle.db
      .select({ id: leadCycles.id, leadId: leadCycles.leadId })
      .from(leadCycles)
      .innerJoin(leads, eq(leads.id, leadCycles.leadId))
      .where(eq(leads.phone, "5579999990012"));
    expect(
      await dbError(
        handle.db.update(leadCycles).set({ endedAt: sql`now()`, endedBy: org.ids.supA, endReason: "REDISTRIBUTED" }).where(eq(leadCycles.id, open.id)),
      ),
    ).toContain("precisa de um ciclo aberto");
    expect(
      await dbError(
        handle.db
          .insert(leadCycles)
          .values({ leadId: open.leadId, number: 2, kind: "REWORK", assignedSellerId: org.ids.sellerA2, teamId: org.ids.teamA, startedBy: org.ids.supA }),
      ),
    ).toContain("lead_cycles_one_open_per_lead");
  });

  it("ciclo encerrado é imutável", async () => {
    expect(await dbError(handle.db.update(leadCycles).set({ endReason: "WON" }).where(eq(leadCycles.id, lead.cycleId)))).toContain("imutável");
  });
});

describe("sem exclusão física; observações e eventos append-only", () => {
  it("bloqueia DELETE, UPDATE e TRUNCATE", async () => {
    await handle.db
      .insert(leadNotes)
      .values({ leadId: lead.id, cycleId: lead.cycleId, stage: "NEW", authorId: org.ids.sellerA1, body: "Observação" });
    for (const statement of [
      handle.db.delete(leads),
      handle.db.delete(leadCycles),
      handle.db.delete(leadNotes),
      handle.db.update(leadNotes).set({ body: "editada" }),
      handle.db.delete(leadEvents),
      handle.db.update(leadEvents).set({ stage: "CLOSED" }),
      handle.db.execute(sql`truncate lead_events`),
      handle.db.execute(sql`truncate leads cascade`),
    ]) {
      expect(await dbError(statement)).toContain("não permitida");
    }
  });
});
