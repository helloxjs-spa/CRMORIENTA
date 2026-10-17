import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents, certificates } from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import {
  getSaleItemCertificates,
  ITEM_REMOVED,
  listCertificates,
  registerCertificate,
  SALE_NOT_VALID,
} from "@/server/modules/certificates/certificates.service";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, getSale, reverseSale, updateSale } from "@/server/modules/sales/sales.service";
import { changeSellerTeam } from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourseWithCost } from "../support/sales";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;

let seq = 0;
const nextPhone = () => `(79) 94${String(++seq).padStart(7, "0")}`;
const ctx = (userId: string) => org.ctx(userId);

/** Venda Pix registrada pelo ADMIN (que informa a data) para um lead novo do vendedor. */
async function saleFor(sellerId: string, prices: number[] = [100_000], studentName = `Aluno ${seq + 1}`): Promise<string> {
  const lead = await createLead(await ctx(sellerId), { name: studentName, phone: nextPhone(), interestCourseId: course });
  const items = prices.map((priceCents) => ({ courseId: course, priceCents }));
  const input = { requestId: crypto.randomUUID(), leadId: lead.id, sellerId, saleDate: "2026-08-10", paymentMethod: "PIX", items };
  return (await createSale(await ctx(org.ids.admin), input)).saleId;
}
const itemsOf = async (saleId: string) => (await getSale(await ctx(org.ids.admin), saleId)).items.map((item) => item.id);
const cert = (saleItemId: string, overrides: Record<string, unknown> = {}) => ({
  saleItemId,
  completedOn: "2026-09-01",
  deliveredOn: "2026-09-10",
  certifier: "Certificadora Alfa",
  ...overrides,
});
const countFor = async (saleItemId: string) => (await handle.db.select().from(certificates).where(eq(certificates.saleItemId, saleItemId))).length;
const tomorrow = () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);
});
afterAll(() => handle.close());

describe("registro", () => {
  it("SELLER registra na própria venda; o mesmo curso repetido são itens distintos; auditoria na mesma transação", async () => {
    const saleId = await saleFor(org.ids.sellerA1, [100_000, 100_000]);
    const [first, second] = await itemsOf(saleId);
    const seller = await ctx(org.ids.sellerA1);

    const { certificateId } = await registerCertificate(seller, cert(first));
    await registerCertificate(seller, cert(second, { completedOn: "2026-09-05", deliveredOn: "2026-09-05", certifier: "  Beta  " }));

    const [row] = await handle.db.select().from(certificates).where(eq(certificates.id, certificateId));
    expect(row).toMatchObject({ saleItemId: first, completedOn: "2026-09-01", deliveredOn: "2026-09-10", certifier: "Certificadora Alfa", createdBy: org.ids.sellerA1 });
    expect((await handle.db.select().from(certificates).where(eq(certificates.saleItemId, second)))[0].certifier).toBe("Beta");

    const [audit] = await handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "certificate.created"), eq(auditEvents.entityId, certificateId)));
    expect(audit).toMatchObject({ actorId: org.ids.sellerA1, entityType: "certificate", teamId: org.ids.teamA });
    expect(audit.metadata).toMatchObject({ saleId, saleItemId: first, completedOn: "2026-09-01", deliveredOn: "2026-09-10" });

    expect(await getSaleItemCertificates(seller, saleId)).toEqual({
      [first]: { id: certificateId, completedOn: "2026-09-01", deliveredOn: "2026-09-10", certifier: "Certificadora Alfa" },
      [second]: expect.objectContaining({ certifier: "Beta" }),
    });
  });

  it("um certificado por item: o segundo registro é recusado", async () => {
    const [item] = await itemsOf(await saleFor(org.ids.sellerA1));
    await registerCertificate(await ctx(org.ids.supA), cert(item));
    await expect(registerCertificate(await ctx(org.ids.admin), cert(item))).rejects.toBeInstanceOf(ConflictError);
    expect(await countFor(item)).toBe(1);
  });

  it("dados obrigatórios e coerentes; datas não futuras; campos extras recusados — nada é gravado", async () => {
    const [item] = await itemsOf(await saleFor(org.ids.sellerA1));
    const seller = await ctx(org.ids.sellerA1);
    for (const bad of [
      { completedOn: "2026-09-10", deliveredOn: "2026-09-01" },
      { certifier: "   " },
      { certifier: "x".repeat(201) },
      { completedOn: tomorrow(), deliveredOn: tomorrow() },
      { deliveredOn: tomorrow() },
      { completedOn: "" },
      { createdBy: org.ids.admin },
      { saleDate: "2026-01-01" },
    ]) {
      await expect(registerCertificate(seller, cert(item, bad)), JSON.stringify(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await countFor(item)).toBe(0);
  });

  it("só itens atuais de vendas válidas (C51): venda estornada e item removido são recusados", async () => {
    const admin = await ctx(org.ids.admin);
    const reversed = await saleFor(org.ids.sellerA1);
    const [reversedItem] = await itemsOf(reversed);
    await reverseSale(admin, reversed, { expectedVersion: (await getSale(admin, reversed)).version, reason: "Desistência" });
    await expect(registerCertificate(admin, cert(reversedItem))).rejects.toThrow(SALE_NOT_VALID);

    const twoItems = await saleFor(org.ids.sellerA1, [100_000, 50_000]);
    const loaded = await getSale(admin, twoItems);
    const removed = loaded.items.find((item) => item.priceCents === 50_000)!.id;
    await updateSale(await ctx(org.ids.supA), twoItems, { expectedVersion: loaded.version, removeItemIds: [removed] });
    await expect(registerCertificate(admin, cert(removed))).rejects.toThrow(ITEM_REMOVED);
    expect((await countFor(reversedItem)) + (await countFor(removed))).toBe(0);
  });
});

describe("escopo", () => {
  it("fora do escopo → NotFound (vendedor de outra venda, supervisor de outra equipe, item inexistente)", async () => {
    const saleId = await saleFor(org.ids.sellerA1);
    const [item] = await itemsOf(saleId);
    await expect(registerCertificate(await ctx(org.ids.sellerB1), cert(item))).rejects.toBeInstanceOf(NotFoundError);
    await expect(registerCertificate(await ctx(org.ids.supB), cert(item))).rejects.toBeInstanceOf(NotFoundError);
    await expect(registerCertificate(await ctx(org.ids.admin), cert(crypto.randomUUID()))).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSaleItemCertificates(await ctx(org.ids.sellerB1), saleId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await countFor(item)).toBe(0);
  });

  it("C50: vendedor transferido leva os certificados para o supervisor atual; sem equipe, só ADMIN e ele mesmo", async () => {
    const mover = await insertUser(handle, { name: "Vendedor Certificado", role: "SELLER", teamId: org.ids.teamA });
    const [item] = await itemsOf(await saleFor(mover, [100_000], "Aluna Transferida"));
    await registerCertificate(await ctx(mover), cert(item));
    const visibleTo = async (userId: string) =>
      (await listCertificates(await ctx(userId), { search: "Aluna Transferida" })).items.map((c) => c.studentName);

    expect(await visibleTo(org.ids.supA)).toEqual(["Aluna Transferida"]);
    await changeSellerTeam(await ctx(org.ids.admin), mover, { teamId: org.ids.teamB });
    expect(await visibleTo(org.ids.supA)).toEqual([]);
    expect(await visibleTo(org.ids.supB)).toEqual(["Aluna Transferida"]);

    await changeSellerTeam(await ctx(org.ids.admin), mover, { teamId: null });
    expect(await visibleTo(org.ids.supB)).toEqual([]);
    expect(await visibleTo(org.ids.admin)).toEqual(["Aluna Transferida"]);
    expect(await visibleTo(mover)).toEqual(["Aluna Transferida"]);
  });
});

describe("listagem, período e contagem", () => {
  it("filtra pela data de conclusão ou de entrega; conta certificados e alunos distintos; vendedor vê só os seus", async () => {
    const seller = await insertUser(handle, { name: "Vendedor Lista", role: "SELLER", teamId: org.ids.teamB });
    const saleId = await saleFor(seller, [100_000, 100_000], "Aluno Dois Cursos");
    const [a, b] = await itemsOf(saleId);
    const [c] = await itemsOf(await saleFor(seller, [100_000], "Aluno Um Curso"));
    const me = await ctx(seller);
    await registerCertificate(me, cert(a, { completedOn: "2026-03-10", deliveredOn: "2026-04-05" }));
    await registerCertificate(me, cert(b, { completedOn: "2026-03-20", deliveredOn: "2026-03-25" }));
    await registerCertificate(me, cert(c, { completedOn: "2026-04-01", deliveredOn: "2026-04-02" }));

    const all = await listCertificates(me);
    expect(all).toMatchObject({ total: 3, students: 2 });
    expect(all.items.every((item) => item.sellerName === "Vendedor Lista")).toBe(true);
    expect(all.items[0]).toMatchObject({ courseName: "Pedagogia", saleDate: "2026-08-10", saleStatus: "ACTIVE", itemRemoved: false, createdByName: "Vendedor Lista" });

    const deliveredInApril = await listCertificates(me, { dateField: "delivered", dateFrom: "2026-04-01", dateTo: "2026-04-30" });
    expect(deliveredInApril).toMatchObject({ total: 2, students: 2 });
    expect(deliveredInApril.items.map((item) => item.deliveredOn)).toEqual(["2026-04-05", "2026-04-02"]);

    const completedInMarch = await listCertificates(me, { dateField: "completed", dateFrom: "2026-03-01", dateTo: "2026-03-31" });
    expect(completedInMarch).toMatchObject({ total: 2, students: 1 });

    expect((await listCertificates(await ctx(org.ids.sellerA1), { dateField: "completed", dateFrom: "2026-03-01", dateTo: "2026-04-30" })).total).toBe(0);
    expect((await listCertificates(await ctx(org.ids.supB), { search: "Aluno Dois" })).total).toBe(2);
  });

  it("filtros inválidos são recusados", async () => {
    const admin = await ctx(org.ids.admin);
    await expect(listCertificates(admin, { dateFrom: "2026-05-01", dateTo: "2026-04-01" })).rejects.toBeInstanceOf(ValidationError);
    await expect(listCertificates(admin, { dateField: "sale" })).rejects.toBeInstanceOf(ValidationError);
    await expect(listCertificates(admin, { sellerId: org.ids.sellerA1 })).rejects.toBeInstanceOf(ValidationError);
  });
});
