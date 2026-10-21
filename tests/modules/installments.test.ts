import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { DatabaseHandle } from "@/server/db/connect";
import { MAX_INSTALLMENTS } from "@/lib/installments";
import { auditEvents, installments, saleItems, sales } from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { getSalesIndicators } from "@/server/modules/dashboard/dashboard.service";
import {
  getSaleInstallments,
  INSTALLMENT_NOT_OPEN,
  INSTALLMENTS_EXCEED_TOTAL,
  INSTALLMENTS_OVER_LIMIT,
  INSTALLMENTS_PAID_LOCKED,
  listInstallments,
  markInstallmentPaid,
} from "@/server/modules/installments/installments.service";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, getSale, reactivateSale, reverseSale, updateSale } from "@/server/modules/sales/sales.service";
import { changeSellerTeam } from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourseWithCost } from "../support/sales";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;

let seq = 0;
const nextPhone = () => `(79) 96${String(++seq).padStart(7, "0")}`;
const ctx = (userId: string) => org.ctx(userId);

/** Venda registrada pelo ADMIN (que informa a data) para um lead novo do vendedor. */
async function sale(
  sellerId: string,
  opts: { prices?: number[]; method?: "PIX" | "CARD"; count?: number; date?: string; name?: string } = {},
): Promise<string> {
  const lead = await createLead(await ctx(sellerId), { name: opts.name ?? `Cliente Parcela ${seq + 1}`, phone: nextPhone(), interestCourseId: course });
  const method = opts.method ?? "CARD";
  const input = {
    requestId: crypto.randomUUID(),
    leadId: lead.id,
    sellerId,
    saleDate: opts.date ?? "2026-03-15",
    paymentMethod: method,
    ...(method === "CARD" ? { installmentCount: opts.count ?? 3 } : {}),
    items: (opts.prices ?? [10_000]).map((priceCents) => ({ courseId: course, priceCents })),
  };
  return (await createSale(await ctx(org.ids.admin), input)).saleId;
}
/** Cronograma atual (número, valor, vencimento, situação). */
const schedule = async (saleId: string) =>
  handle.db
    .select({ id: installments.id, number: installments.number, amountCents: installments.amountCents, dueDate: installments.dueDate, status: installments.status })
    .from(installments)
    .where(and(eq(installments.saleId, saleId), isNull(installments.replacedAt)))
    .orderBy(asc(installments.number));
const allRows = (saleId: string) => handle.db.select().from(installments).where(eq(installments.saleId, saleId));
const version = async (saleId: string) => (await getSale(await ctx(org.ids.admin), saleId)).version;
const pay = async (userId: string, installmentId: string) => markInstallmentPaid(await ctx(userId), { installmentId });
/** Retrato direto do banco: total e situação da venda, todos os itens (inclusive removidos), parcelas e versão. */
const saleState = async (saleId: string) => ({
  sale: (await handle.db.select({ totalCents: sales.totalCents, installmentCount: sales.installmentCount, status: sales.status }).from(sales).where(eq(sales.id, saleId)))[0],
  items: await handle.db
    .select({ id: saleItems.id, priceCents: saleItems.priceCents, removedAt: saleItems.removedAt })
    .from(saleItems)
    .where(eq(saleItems.saleId, saleId))
    .orderBy(asc(saleItems.id)),
  installments: (await allRows(saleId)).sort((a, b) => a.id.localeCompare(b.id)),
  version: await version(saleId),
});

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 4_000);
});
afterAll(() => handle.close());

describe("cronograma gerado com a venda (C52)", () => {
  it("cartão: N parcelas, 1ª um mês após a venda, centavos na 1ª; Pix: nenhuma", async () => {
    const card = await sale(org.ids.sellerA1, { count: 3 });
    expect((await schedule(card)).map(({ number, amountCents, dueDate, status }) => [number, amountCents, dueDate, status])).toEqual([
      [1, 3_334, "2026-04-15", "OPEN"],
      [2, 3_333, "2026-05-15", "OPEN"],
      [3, 3_333, "2026-06-15", "OPEN"],
    ]);
    expect(await schedule(await sale(org.ids.sellerA1, { method: "PIX" }))).toEqual([]);
  });

  it("fim de mês: o banco confere a mesma aritmética de datas do serviço", async () => {
    const saleId = await sale(org.ids.sellerA1, { date: "2026-01-31", count: 3 });
    expect((await schedule(saleId)).map((p) => p.dueDate)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("faturamento e comissão continuam pela venda, não pelos recebimentos (C45)", async () => {
    const before = await getSalesIndicators(await ctx(org.ids.admin), { dateFrom: "2026-02-01", dateTo: "2026-02-28" });
    await sale(org.ids.sellerA1, { date: "2026-02-10", count: 2, prices: [20_000] });
    const after = await getSalesIndicators(await ctx(org.ids.admin), { dateFrom: "2026-02-01", dateTo: "2026-02-28" });
    expect(after.revenueCents - before.revenueCents).toBe(20_000);
    expect(after.commissionCents - before.commissionCents).toBe(BUSINESS_RULES.commissionPerItemCents);
  });
});

describe("pagamento", () => {
  it("SELLER marca a própria parcela como paga: data do servidor, autor e auditoria; segunda vez é recusada", async () => {
    const saleId = await sale(org.ids.sellerA1);
    const [first] = await schedule(saleId);
    await pay(org.ids.sellerA1, first.id);

    const [row] = await handle.db.select().from(installments).where(eq(installments.id, first.id));
    expect(row).toMatchObject({ status: "PAID", paidBy: org.ids.sellerA1 });
    expect(row.paidAt).toBeInstanceOf(Date);
    const [audit] = await handle.db.select().from(auditEvents).where(and(eq(auditEvents.action, "installment.paid"), eq(auditEvents.entityId, first.id)));
    expect(audit).toMatchObject({ actorId: org.ids.sellerA1, entityType: "installment", teamId: org.ids.teamA });
    expect(audit.metadata).toMatchObject({ saleId, number: 1, amountCents: 3_334, dueDate: "2026-04-15" });

    await expect(pay(org.ids.supA, first.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(markInstallmentPaid(await ctx(org.ids.admin), { installmentId: first.id, paidAt: "2026-01-01" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("escopo (C50): vendedor e supervisor de fora → NotFound; supervisor atual do vendedor transferido pode pagar", async () => {
    const mover = await insertUser(handle, { name: "Vendedor Parcelas", role: "SELLER", teamId: org.ids.teamA });
    const saleId = await sale(mover);
    const [first, second] = await schedule(saleId);
    await expect(pay(org.ids.sellerB1, first.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(pay(org.ids.supB, first.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSaleInstallments(await ctx(org.ids.sellerB1), saleId)).rejects.toBeInstanceOf(NotFoundError);

    await changeSellerTeam(await ctx(org.ids.admin), mover, { teamId: org.ids.teamB });
    await expect(pay(org.ids.supA, first.id)).rejects.toBeInstanceOf(NotFoundError);
    await pay(org.ids.supB, first.id);
    await pay(org.ids.admin, second.id);
    expect((await schedule(saleId)).map((p) => p.status)).toEqual(["PAID", "PAID", "OPEN"]);
  });
});

describe("venda alterada depois do cronograma", () => {
  it("sem parcela paga: total, quantidade, data e forma de pagamento refazem o cronograma (o anterior fica como histórico)", async () => {
    const saleId = await sale(org.ids.sellerA1, { count: 3 });
    const supervisor = await ctx(org.ids.supA);

    // SELLER inclui um curso: novo total → novo cronograma.
    await updateSale(await ctx(org.ids.sellerA1), saleId, { expectedVersion: await version(saleId), addItems: [{ courseId: course, priceCents: 5_000 }] });
    expect((await schedule(saleId)).map((p) => p.amountCents)).toEqual([5_000, 5_000, 5_000]);

    await updateSale(supervisor, saleId, { expectedVersion: await version(saleId), installmentCount: 2 });
    expect((await schedule(saleId)).map((p) => p.amountCents)).toEqual([7_500, 7_500]);

    await updateSale(await ctx(org.ids.admin), saleId, { expectedVersion: await version(saleId), saleDate: "2026-05-31" });
    expect((await schedule(saleId)).map((p) => p.dueDate)).toEqual(["2026-06-30", "2026-07-31"]);

    await updateSale(supervisor, saleId, { expectedVersion: await version(saleId), paymentMethod: "PIX", installmentCount: null });
    expect(await schedule(saleId)).toEqual([]);
    const history = await allRows(saleId);
    expect(history).toHaveLength(3 + 3 + 2 + 2);
    expect(history.every((p) => p.status === "CANCELED" && p.replacedAt !== null)).toBe(true);

    await updateSale(supervisor, saleId, { expectedVersion: await version(saleId), paymentMethod: "CARD", installmentCount: 1 });
    expect((await schedule(saleId)).map((p) => [p.amountCents, p.dueDate, p.status])).toEqual([[15_000, "2026-06-30", "OPEN"]]);
  });

  it("troca de responsável não mexe nas parcelas", async () => {
    const saleId = await sale(org.ids.sellerA1);
    const before = await schedule(saleId);
    await updateSale(await ctx(org.ids.supA), saleId, { expectedVersion: await version(saleId), sellerId: org.ids.sellerA2 });
    expect(await schedule(saleId)).toEqual(before);
  });

  it("com parcela paga: mudanças que refazem o cronograma são recusadas e nada é gravado", async () => {
    const saleId = await sale(org.ids.sellerA1, { count: 3 });
    const [first] = await schedule(saleId);
    await pay(org.ids.sellerA1, first.id);
    const before = await saleState(saleId);
    const v = before.version;

    for (const [userId, input] of [
      [org.ids.sellerA1, { addItems: [{ courseId: course, priceCents: 5_000 }] }],
      [org.ids.supA, { installmentCount: 6 }],
      [org.ids.supA, { paymentMethod: "PIX", installmentCount: null }],
      [org.ids.admin, { saleDate: "2026-03-20" }],
    ] as const) {
      await expect(updateSale(await ctx(userId), saleId, { expectedVersion: v, ...input })).rejects.toThrow(INSTALLMENTS_PAID_LOCKED);
      // Nada mudou: total, itens (o incluído não ficou), parcelas (a paga continua paga) e versão.
      expect(await saleState(saleId)).toEqual(before);
    }
    expect(before.items).toHaveLength(1);
    // Troca de responsável continua possível.
    await updateSale(await ctx(org.ids.supA), saleId, { expectedVersion: v, sellerId: org.ids.sellerA2 });
  });
});

describe("quantidade de parcelas × total (cada parcela com pelo menos R$ 0,01)", () => {
  const exceeds = { fieldErrors: { installmentCount: [INSTALLMENTS_EXCEED_TOTAL] } };

  it("criação: quantidade maior que o total em centavos é recusada antes de gravar; igual ao total é aceita", async () => {
    const lead = await createLead(await ctx(org.ids.sellerA1), { name: "Cliente Centavos", phone: nextPhone(), interestCourseId: course });
    const input = (installmentCount: number) => ({
      requestId: crypto.randomUUID(),
      leadId: lead.id,
      paymentMethod: "CARD" as const,
      installmentCount,
      items: [{ courseId: course, priceCents: 100 }],
    });
    const rejected = input(101);
    const error = await createSale(await ctx(org.ids.sellerA1), rejected).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject(exceeds);
    expect(await allRows(rejected.requestId)).toEqual([]);
    expect(await handle.db.select().from(sales).where(eq(sales.id, rejected.requestId))).toEqual([]);

    const { saleId } = await createSale(await ctx(org.ids.sellerA1), input(100));
    const rows = await schedule(saleId);
    expect(rows).toHaveLength(100);
    expect(rows.every((p) => p.amountCents === 1)).toBe(true);
  });

  it("edição: remover item, corrigir preço ou aumentar parcelas deixando o total insuficiente é recusado e nada muda", async () => {
    const saleId = await sale(org.ids.sellerA1, { prices: [500, 50], count: 100 });
    const items = (await getSale(await ctx(org.ids.admin), saleId)).items;
    const big = items.find((i) => i.priceCents === 500)!;
    const before = await saleState(saleId);
    const v = before.version;
    const supervisor = await ctx(org.ids.supA);

    for (const input of [
      { removeItemIds: [big.id] }, // total cai para 50 centavos
      { repriceItems: [{ itemId: big.id, priceCents: 40 }] }, // total cai para 90 centavos
      { installmentCount: 551 }, // mais parcelas que centavos (abaixo do teto técnico)
    ]) {
      const error = await updateSale(supervisor, saleId, { expectedVersion: v, ...input }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject(exceeds);
      // Nada mudou: total, itens (nenhum removido nem com preço novo), parcelas e versão.
      expect(await saleState(saleId)).toEqual(before);
    }
    expect(before.sale).toMatchObject({ totalCents: 550, installmentCount: 100 });
    expect(before.items.every((i) => i.removedAt === null)).toBe(true);

    // Junto com a redução da quantidade, a mesma remoção passa.
    await updateSale(supervisor, saleId, { expectedVersion: v, removeItemIds: [big.id], installmentCount: 50 });
    expect((await schedule(saleId)).map((p) => p.amountCents)).toEqual(Array(50).fill(1));
  });

  it("Pix não tem parcelas: a regra não se aplica", async () => {
    const saleId = await sale(org.ids.sellerA1, { method: "PIX", prices: [1] });
    expect(await schedule(saleId)).toEqual([]);
  });
});

describe(`teto técnico de parcelas (MAX_INSTALLMENTS = ${MAX_INSTALLMENTS})`, () => {
  const overLimit = { fieldErrors: { installmentCount: [INSTALLMENTS_OVER_LIMIT] } };

  it("criação: exatamente o teto é aceito; teto + 1 é recusado no campo, sem gravar nada", async () => {
    const lead = await createLead(await ctx(org.ids.sellerA1), { name: "Cliente Teto", phone: nextPhone(), interestCourseId: course });
    const input = (installmentCount: number) => ({
      requestId: crypto.randomUUID(),
      leadId: lead.id,
      paymentMethod: "CARD" as const,
      installmentCount,
      items: [{ courseId: course, priceCents: 500_000 }],
    });
    const rejected = input(MAX_INSTALLMENTS + 1);
    const error = await createSale(await ctx(org.ids.sellerA1), rejected).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject(overLimit);
    expect(await handle.db.select().from(sales).where(eq(sales.id, rejected.requestId))).toEqual([]);
    expect(await allRows(rejected.requestId)).toEqual([]);

    const { saleId } = await createSale(await ctx(org.ids.sellerA1), input(MAX_INSTALLMENTS));
    expect(await schedule(saleId)).toHaveLength(MAX_INSTALLMENTS);
  });

  it("edição: mudar a quantidade para teto + 1 é recusado sem alterar nada; para o teto é aceito", async () => {
    const saleId = await sale(org.ids.sellerA1, { prices: [500_000], count: 3 });
    const supervisor = await ctx(org.ids.supA);
    const before = await saleState(saleId);
    const error = await updateSale(supervisor, saleId, { expectedVersion: before.version, installmentCount: MAX_INSTALLMENTS + 1 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject(overLimit);
    expect(await saleState(saleId)).toEqual(before);

    await updateSale(supervisor, saleId, { expectedVersion: before.version, installmentCount: MAX_INSTALLMENTS });
    expect(await schedule(saleId)).toHaveLength(MAX_INSTALLMENTS);
  });

  // Venda antiga acima do teto (o teto só vale quando a quantidade muda):
  // tests/modules/installments-legacy-limit.test.ts, com o teto reduzido por
  // vi.mock para não refazer cronogramas de mais de 1.000 parcelas.
});

describe("estorno e reativação", () => {
  it("estorno cancela as em aberto (a paga continua paga); reativação as reabre; cancelada não pode ser paga", async () => {
    const saleId = await sale(org.ids.sellerA1, { count: 3 });
    const [first, second] = await schedule(saleId);
    await pay(org.ids.sellerA1, first.id);
    const admin = await ctx(org.ids.admin);

    await reverseSale(admin, saleId, { expectedVersion: await version(saleId), reason: "Desistência" });
    expect((await schedule(saleId)).map((p) => p.status)).toEqual(["PAID", "CANCELED", "CANCELED"]);
    await expect(pay(org.ids.admin, second.id)).rejects.toThrow(INSTALLMENT_NOT_OPEN);

    await reactivateSale(admin, saleId, { expectedVersion: await version(saleId), reason: "Voltou" });
    expect((await schedule(saleId)).map((p) => p.status)).toEqual(["PAID", "OPEN", "OPEN"]);
    await pay(org.ids.sellerA1, second.id);
  });

  it("venda estornada sem parcela paga editada: o novo cronograma nasce cancelado e a reativação o reabre", async () => {
    const saleId = await sale(org.ids.sellerA1, { count: 2 });
    const supervisor = await ctx(org.ids.supA);
    await reverseSale(supervisor, saleId, { expectedVersion: await version(saleId), reason: "Erro" });
    await updateSale(supervisor, saleId, { expectedVersion: await version(saleId), installmentCount: 4 });
    expect((await schedule(saleId)).map((p) => p.status)).toEqual(["CANCELED", "CANCELED", "CANCELED", "CANCELED"]);
    await reactivateSale(supervisor, saleId, { expectedVersion: await version(saleId), reason: "Corrigido" });
    expect((await schedule(saleId)).map((p) => [p.amountCents, p.status])).toEqual([
      [2_500, "OPEN"],
      [2_500, "OPEN"],
      [2_500, "OPEN"],
      [2_500, "OPEN"],
    ]);
  });
});

describe("listagem", () => {
  it("filtra por situação (inclusive vencidas) e período de vencimento; resumo com quantidade e valor; vendedor vê só as suas", async () => {
    const seller = await insertUser(handle, { name: "Vendedor Lista Parcelas", role: "SELLER", teamId: org.ids.teamB });
    const old = await sale(seller, { date: "2025-01-10", count: 2, prices: [20_000], name: "Aluno Antigo" });
    const future = await sale(seller, { date: "2099-01-10", count: 2, prices: [30_000], name: "Aluno Futuro" });
    const [paid] = await schedule(old);
    await pay(seller, paid.id);
    const me = await ctx(seller);

    expect(await listInstallments(me)).toMatchObject({ total: 4, amountCents: 50_000 });
    expect((await listInstallments(me, { status: "PAID" })).items.map((p) => [p.leadName, p.number, p.paidByName])).toEqual([
      ["Aluno Antigo", 1, "Vendedor Lista Parcelas"],
    ]);
    expect((await listInstallments(me, { status: "OVERDUE" })).items.map((p) => [p.leadName, p.number, p.dueDate])).toEqual([
      ["Aluno Antigo", 2, "2025-03-10"],
    ]);
    expect(await listInstallments(me, { status: "OPEN" })).toMatchObject({ total: 3, amountCents: 40_000 });
    const window = await listInstallments(me, { dueFrom: "2099-02-01", dueTo: "2099-02-28" });
    expect(window.items.map((p) => [p.saleId, p.number, p.installmentCount, p.amountCents])).toEqual([[future, 1, 2, 15_000]]);

    expect((await listInstallments(await ctx(org.ids.supA), { search: "Aluno Antigo" })).total).toBe(0);
    expect((await listInstallments(await ctx(org.ids.supB), { search: "Aluno Antigo" })).total).toBe(2);
    expect((await getSaleInstallments(me, old)).map((p) => p.status)).toEqual(["PAID", "OPEN"]);
  });

  it("filtros inválidos e campos extras são recusados", async () => {
    const admin = await ctx(org.ids.admin);
    await expect(listInstallments(admin, { dueFrom: "2026-05-01", dueTo: "2026-04-01" })).rejects.toBeInstanceOf(ValidationError);
    await expect(listInstallments(admin, { status: "LATE" })).rejects.toBeInstanceOf(ValidationError);
    await expect(listInstallments(admin, { sellerId: org.ids.sellerA1 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("integridade no banco (006)", () => {
  const fails = async (statement: ReturnType<typeof sql>, pattern: RegExp) => {
    const error = (await handle.db.execute(statement).then(
      () => null,
      (e: unknown) => e,
    )) as { message: string; cause?: { message?: string } } | null;
    expect(error, String(pattern)).not.toBeNull();
    expect(`${error!.message} ${error!.cause?.message ?? ""}`).toMatch(pattern);
  };

  it("parcela paga é imutável (sem desfazer); sem exclusão; cronograma fora da regra é recusado no COMMIT", async () => {
    const saleId = await sale(org.ids.sellerA1, { count: 2 });
    const [first, second] = await schedule(saleId);
    await pay(org.ids.sellerA1, first.id);

    await fails(sql`update installments set status = 'OPEN', paid_at = null, paid_by = null where id = ${first.id}`, /paga é imutável/);
    await fails(sql`delete from installments where id = ${second.id}`, /não permitida/);
    await fails(sql`update installments set due_date = '2030-01-01' where id = ${second.id}`, /imutáveis/);
    await fails(sql`update installments set status = 'CANCELED' where id = ${second.id}`, /válida não pode ter parcela cancelada/);
    await fails(
      sql`insert into installments (sale_id, number, amount_cents, due_date) values (${saleId}, 3, 1, '2026-06-15')`,
      /cronograma de parcelas deve ter/,
    );
  });
});
