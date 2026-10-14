import { randomUUID } from "node:crypto";
import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "@/server/context";
import type { DatabaseHandle } from "@/server/db/connect";
import { leadEvents, leads, saleItems, sales, teams } from "@/server/db/schema";
import { createLead, getLeadTimeline, REVERSAL_NEEDS_VALID_OWNER } from "@/server/modules/leads/leads.service";
import {
  createSale,
  getSale,
  getSaleHistoryView,
  listSales,
  listSaleSellerOptions,
  REQUEST_ID_REUSED,
  SALE_CHANGED_CONCURRENTLY,
  SALE_REVERSED_READ_ONLY,
} from "@/server/modules/sales/sales.service";
import { changeSellerTeam } from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { setLeadStage } from "../support/leads";
import { insertCourseWithCost, saleInput } from "../support/sales";

/**
 * Server Actions de Vendas chamadas diretamente (como um POST forjado faria).
 * Só a sessão é substituída: action → runAction → serviço → banco são reais.
 */
const session = vi.hoisted(() => ({ current: null as ServiceContext | null }));
vi.mock("@/server/next/session", () => ({
  requireServiceContext: async () => {
    if (!session.current) throw new Error("sem sessão no teste");
    return session.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const actions = await import("@/app/(app)/vendas/actions");

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let course2: string;
let seq = 0;

const IDLE = { status: "idle" } as const;
const FORBIDDEN = "Você não tem permissão para executar esta ação.";
const NOT_FOUND = "Registro não encontrado.";

type Fields = Record<string, string | string[]>;
function form(fields: Fields): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const v of [value].flat()) data.append(key, v);
  return data;
}

async function as(userId: string) {
  session.current = await org.ctx(userId);
}
const ctx = (userId: string) => org.ctx(userId);

async function newLead(sellerId: string, name = `Cliente ${++seq}`): Promise<string> {
  return (await createLead(await ctx(sellerId), { name, phone: `(79) 94${String(++seq).padStart(7, "0")}`, interestCourseId: course })).id;
}

const saleRow = async (id: string) => (await handle.db.select().from(sales).where(eq(sales.id, id)))[0];
const leadRow = async (id: string) => (await handle.db.select().from(leads).where(eq(leads.id, id)))[0];
const currentPrices = async (saleId: string) =>
  (
    await handle.db
      .select({ price: saleItems.priceCents })
      .from(saleItems)
      .where(and(eq(saleItems.saleId, saleId), isNull(saleItems.removedAt)))
      
  )
    .map((r) => r.price)
    // Itens da mesma transação têm o mesmo added_at: compara sem depender da ordem.
    .sort((a, b) => a - b);
const salesOf = async (leadId: string) => (await handle.db.select({ n: count() }).from(sales).where(eq(sales.leadId, leadId)))[0].n;

/** Formulário de registro como a tela envia (preços em reais, texto). */
function createForm(leadId: string, fields: Fields = {}): Fields {
  return {
    requestId: randomUUID(),
    leadId,
    paymentMethod: "PIX",
    itemCourseId: [course],
    itemPrice: ["1.500,00"],
    ...fields,
  };
}

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);
  course2 = await insertCourseWithCost(handle, "Administração", 55_000);
});
afterAll(() => handle.close());

describe("registro pela action", () => {
  it("Pix com vários cursos (inclusive repetidos): preços em reais viram centavos e o total é a soma, ignorando total forjado", async () => {
    await as(org.ids.sellerA1);
    const leadId = await newLead(org.ids.sellerA1);
    const fields = createForm(leadId, {
      itemCourseId: [course, course2, course],
      itemPrice: ["1.500,00", "R$ 999,90", "0,10"],
      totalCents: "1",
      costSnapshotCents: "0",
      sellerId: org.ids.sellerA1,
    });
    const result = await actions.createSaleAction(IDLE, form(fields));
    expect(result).toMatchObject({ status: "success", message: "Venda registrada.", redirectTo: `/vendas/${fields.requestId}` });
    const sale = await saleRow(fields.requestId as string);
    expect(sale).toMatchObject({ totalCents: 150_000 + 99_990 + 10, paymentMethod: "PIX", installmentCount: null, sellerId: org.ids.sellerA1 });
    expect(await currentPrices(sale.id)).toEqual([10, 99_990, 150_000]);
  });

  it("Cartão exige parcelas; Pix recusa parcelas", async () => {
    await as(org.ids.sellerA1);
    const leadId = await newLead(org.ids.sellerA1);
    const missing = await actions.createSaleAction(IDLE, form(createForm(leadId, { paymentMethod: "CARD", installmentCount: "" })));
    expect(missing).toMatchObject({ status: "error", fieldErrors: { installmentCount: ["Informe a quantidade de parcelas do cartão."] } });
    const pix = await actions.createSaleAction(IDLE, form(createForm(leadId, { installmentCount: "3" })));
    expect(pix).toMatchObject({ status: "error", fieldErrors: { installmentCount: ["Pix é à vista: não informe parcelas."] } });
    const broken = await actions.createSaleAction(IDLE, form(createForm(leadId, { paymentMethod: "CARD", installmentCount: "2,5" })));
    expect(broken).toMatchObject({ status: "error", fieldErrors: { installmentCount: ["Quantidade de parcelas inválida."] } });
    expect(await salesOf(leadId)).toBe(0);

    const card = createForm(leadId, { paymentMethod: "CARD", installmentCount: "6" });
    expect(await actions.createSaleAction(IDLE, form(card))).toMatchObject({ status: "success" });
    expect(await saleRow(card.requestId as string)).toMatchObject({ paymentMethod: "CARD", installmentCount: 6 });
  });

  it("preço zero, vazio ou inválido volta no campo do item, em português", async () => {
    await as(org.ids.sellerA1);
    const leadId = await newLead(org.ids.sellerA1);
    const result = await actions.createSaleAction(
      IDLE,
      form(createForm(leadId, { itemCourseId: [course, course, course], itemPrice: ["0,00", "", "12,345"] })),
    );
    expect(result).toMatchObject({
      status: "error",
      fieldErrors: {
        "items.0.priceCents": ["O preço de cada curso deve ser maior que zero."],
        "items.1.priceCents": ["Informe o preço do curso."],
        "items.2.priceCents": ["Informe o preço do curso."],
      },
    });
    const none = await actions.createSaleAction(IDLE, form(createForm(leadId, { itemCourseId: [], itemPrice: [] })));
    expect(none).toMatchObject({ status: "error", fieldErrors: { items: ["Inclua pelo menos um curso."] } });
    expect(await salesOf(leadId)).toBe(0);
  });

  it("reenvio com o mesmo requestId não duplica; mesmo id com outros dados é recusado", async () => {
    await as(org.ids.sellerA1);
    const leadId = await newLead(org.ids.sellerA1);
    const fields = createForm(leadId);
    expect(await actions.createSaleAction(IDLE, form(fields))).toMatchObject({ status: "success", message: "Venda registrada." });
    expect(await actions.createSaleAction(IDLE, form(fields))).toMatchObject({
      status: "success",
      message: "Esta venda já tinha sido registrada. Nada foi gravado de novo.",
      redirectTo: `/vendas/${fields.requestId}`,
    });
    expect(await salesOf(leadId)).toBe(1);
    const changed = await actions.createSaleAction(IDLE, form({ ...fields, itemPrice: ["1.600,00"] }));
    expect(changed).toMatchObject({ status: "error", message: REQUEST_ID_REUSED });
    expect(await salesOf(leadId)).toBe(1);
  });

  it("SELLER atribui a colega: resposta genérica, sem dados da venda que saiu do acesso (inclusive no reenvio)", async () => {
    await as(org.ids.sellerA1);
    const leadId = await newLead(org.ids.sellerA1);
    const fields = createForm(leadId, { sellerId: org.ids.sellerA2 });
    const first = await actions.createSaleAction(IDLE, form(fields));
    expect(first).toEqual({
      status: "success",
      message: "Venda registrada para o vendedor escolhido. Ela não aparece no seu acesso.",
      redirectTo: "/vendas",
      at: expect.any(Number),
    });
    const replay = await actions.createSaleAction(IDLE, form(fields));
    expect(replay).toEqual({ status: "success", message: "Esta solicitação já tinha sido registrada.", redirectTo: "/vendas", at: expect.any(Number) });
    expect(JSON.stringify([first, replay])).not.toContain(fields.requestId as string);
    expect(await saleRow(fields.requestId as string)).toMatchObject({ sellerId: org.ids.sellerA2 });
  });

  it("SELLER não informa data nem escolhe vendedor de outra equipe; ADMIN informa a data", async () => {
    await as(org.ids.sellerA1);
    const leadId = await newLead(org.ids.sellerA1);
    expect(await actions.createSaleAction(IDLE, form(createForm(leadId, { saleDate: "2026-01-02" })))).toMatchObject({
      status: "error",
      message: FORBIDDEN,
    });
    expect(await actions.createSaleAction(IDLE, form(createForm(leadId, { sellerId: org.ids.sellerB1 })))).toMatchObject({
      status: "error",
      fieldErrors: { sellerId: ["Selecione você ou um vendedor ativo da sua equipe."] },
    });
    expect(await salesOf(leadId)).toBe(0);

    await as(org.ids.admin);
    const fields = createForm(leadId, { sellerId: org.ids.sellerA1, saleDate: "2026-01-02" });
    expect(await actions.createSaleAction(IDLE, form(fields))).toMatchObject({ status: "success" });
    expect(await saleRow(fields.requestId as string)).toMatchObject({ saleDate: "2026-01-02" });
  });

  it("SUPERVISOR/ADMIN precisam escolher o vendedor", async () => {
    await as(org.ids.supA);
    const leadId = await newLead(org.ids.sellerA1);
    expect(await actions.createSaleAction(IDLE, form(createForm(leadId)))).toMatchObject({
      status: "error",
      fieldErrors: { sellerId: ["Selecione o vendedor responsável pela venda."] },
    });
  });

  it("lead fora do acesso: mesma resposta de inexistente", async () => {
    await as(org.ids.sellerB1);
    const leadId = await newLead(org.ids.sellerA1);
    expect(await actions.createSaleAction(IDLE, form(createForm(leadId)))).toMatchObject({ status: "error", message: NOT_FOUND });
    expect(await salesOf(leadId)).toBe(0);
  });

  it("negociação vencida não impede a venda; o lead vai para Fechamento e a linha do tempo aponta a venda", async () => {
    await as(org.ids.sellerA1);
    const leadId = await newLead(org.ids.sellerA1);
    await setLeadStage(handle, leadId, "NEGOTIATION", -1);
    const fields = createForm(leadId);
    expect(await actions.createSaleAction(IDLE, form(fields))).toMatchObject({ status: "success" });
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED", ownerId: org.ids.sellerA1 });
    const timeline = await getLeadTimeline(await ctx(org.ids.sellerA1), leadId);
    expect(timeline.at(-1)).toMatchObject({ type: "SALE_CREATED", saleId: fields.requestId });
  });
});

/** Venda nova do A1 (PIX, 1 curso por R$ 1.500,00). */
async function saleOfA1() {
  const leadId = await newLead(org.ids.sellerA1);
  const { saleId } = await createSale(await ctx(org.ids.sellerA1), saleInput(leadId, course));
  return { leadId, saleId, version: (await getSale(await ctx(org.ids.sellerA1), saleId)).version };
}

describe("edição pela action", () => {
  it("SELLER só inclui cursos com preço; remover, corrigir preço, pagamento, data e responsável são proibidos", async () => {
    const { saleId, version } = await saleOfA1();
    const [item] = (await getSale(await ctx(org.ids.sellerA1), saleId)).items;
    await as(org.ids.sellerA1);
    const base = { saleId, expectedVersion: String(version) };
    const forgedFields: Fields[] = [
      { removeItemId: item.id },
      { repriceItemId: item.id, repricePrice: "1,00" },
      { paymentMethod: "CARD", installmentCount: "2" },
      { saleDate: "2026-01-01" },
      { sellerId: org.ids.sellerA2 },
    ];
    for (const forged of forgedFields) {
      expect(await actions.updateSaleAction(IDLE, form({ ...base, ...forged }))).toMatchObject({ status: "error", message: FORBIDDEN });
    }
    expect(await currentPrices(saleId)).toEqual([150_000]);

    const result = await actions.updateSaleAction(IDLE, form({ ...base, addCourseId: [course2, course2], addPrice: ["200,00", "300"] }));
    expect(result).toMatchObject({ status: "success", message: "Venda atualizada.", redirectTo: `/vendas/${saleId}` });
    expect(await currentPrices(saleId)).toEqual([20_000, 30_000, 150_000]);
    expect(await saleRow(saleId)).toMatchObject({ totalCents: 200_000 });
  });

  it("SUPERVISOR corrige preço, remove item e troca o pagamento; o total é recalculado", async () => {
    const { saleId, version } = await saleOfA1();
    await as(org.ids.supA);
    const added = await actions.updateSaleAction(
      IDLE,
      form({ saleId, expectedVersion: String(version), addCourseId: [course2], addPrice: ["500,00"] }),
    );
    expect(added).toMatchObject({ status: "success" });
    const sale = await getSale(await ctx(org.ids.supA), saleId);
    const [first, second] = sale.items;
    const result = await actions.updateSaleAction(
      IDLE,
      form({
        saleId,
        expectedVersion: String(sale.version),
        repriceItemId: [first.id],
        repricePrice: ["1.234,56"],
        removeItemId: [second.id],
        paymentMethod: "CARD",
        installmentCount: "10",
      }),
    );
    expect(result).toMatchObject({ status: "success", message: "Venda atualizada." });
    expect(await saleRow(saleId)).toMatchObject({ totalCents: 123_456, paymentMethod: "CARD", installmentCount: 10 });

    const back = await getSale(await ctx(org.ids.supA), saleId);
    const toPix = await actions.updateSaleAction(IDLE, form({ saleId, expectedVersion: String(back.version), paymentMethod: "PIX", installmentCount: "" }));
    expect(toPix).toMatchObject({ status: "success" });
    expect(await saleRow(saleId)).toMatchObject({ paymentMethod: "PIX", installmentCount: null });
  });

  it("versão antiga: conflito claro, nada é gravado; sem mudança: nada a salvar", async () => {
    const { saleId, version } = await saleOfA1();
    await as(org.ids.supA);
    expect(await actions.updateSaleAction(IDLE, form({ saleId, expectedVersion: String(version), addCourseId: [course], addPrice: ["10,00"] }))).toMatchObject({
      status: "success",
    });
    const stale = await actions.updateSaleAction(IDLE, form({ saleId, expectedVersion: String(version), addCourseId: [course], addPrice: ["10,00"] }));
    expect(stale).toMatchObject({ status: "error", message: SALE_CHANGED_CONCURRENTLY });
    expect(await currentPrices(saleId)).toEqual([1_000, 150_000]);

    const now = await getSale(await ctx(org.ids.supA), saleId);
    expect(await actions.updateSaleAction(IDLE, form({ saleId, expectedVersion: String(now.version), paymentMethod: "PIX", installmentCount: "" }))).toMatchObject({
      status: "success",
      message: "Nenhuma alteração para salvar.",
    });
    expect(await actions.updateSaleAction(IDLE, form({ saleId }))).toMatchObject({
      status: "error",
      fieldErrors: { expectedVersion: ["Recarregue a venda e tente novamente."] },
    });
  });

  it("venda de outra equipe: inexistente para o supervisor", async () => {
    const { saleId, version } = await saleOfA1();
    await as(org.ids.supB);
    expect(await actions.updateSaleAction(IDLE, form({ saleId, expectedVersion: String(version), addCourseId: [course], addPrice: ["1,00"] }))).toMatchObject({
      status: "error",
      message: NOT_FOUND,
    });
  });
});

describe("estorno e reativação pela action", () => {
  it("motivo obrigatório; SELLER não estorna; estorno reabre o lead; reativação devolve a Fechamento", async () => {
    const { leadId, saleId, version } = await saleOfA1();
    await as(org.ids.sellerA1);
    expect(await actions.reverseSaleAction(IDLE, form({ saleId, expectedVersion: String(version), reason: "x" }))).toMatchObject({
      status: "error",
      message: FORBIDDEN,
    });

    await as(org.ids.supA);
    expect(await actions.reverseSaleAction(IDLE, form({ saleId, expectedVersion: String(version), reason: "   " }))).toMatchObject({
      status: "error",
      fieldErrors: { reason: ["Informe o motivo."] },
    });
    const reversed = await actions.reverseSaleAction(IDLE, form({ saleId, expectedVersion: String(version), reason: "Cliente desistiu" }));
    expect(reversed).toMatchObject({
      status: "success",
      message: "Venda estornada. O lead voltou para Lead cadastrado, com o mesmo responsável, em um novo ciclo.",
    });
    expect(await saleRow(saleId)).toMatchObject({ status: "REVERSED" });
    expect(await leadRow(leadId)).toMatchObject({ stage: "NEW", ownerId: org.ids.sellerA1 });

    // Reenvio do mesmo estorno (versão antiga): conflito, nada é repetido.
    expect(await actions.reverseSaleAction(IDLE, form({ saleId, expectedVersion: String(version), reason: "Cliente desistiu" }))).toMatchObject({
      status: "error",
      message: SALE_CHANGED_CONCURRENTLY,
    });

    // Venda estornada: somente leitura para o vendedor.
    const afterReverse = await getSale(await ctx(org.ids.supA), saleId);
    await as(org.ids.sellerA1);
    expect(
      await actions.updateSaleAction(IDLE, form({ saleId, expectedVersion: String(afterReverse.version), addCourseId: [course], addPrice: ["1,00"] })),
    ).toMatchObject({ status: "error", message: SALE_REVERSED_READ_ONLY });
    expect(await actions.reactivateSaleAction(IDLE, form({ saleId, expectedVersion: String(afterReverse.version), reason: "ok" }))).toMatchObject({
      status: "error",
      message: FORBIDDEN,
    });

    await as(org.ids.admin);
    expect(await actions.reactivateSaleAction(IDLE, form({ saleId, expectedVersion: String(afterReverse.version), reason: "" }))).toMatchObject({
      status: "error",
      fieldErrors: { reason: ["Informe o motivo."] },
    });
    expect(await actions.reactivateSaleAction(IDLE, form({ saleId, expectedVersion: String(afterReverse.version), reason: "Pagamento confirmado" }))).toMatchObject({
      status: "success",
      message: "Venda reativada. O lead está em Fechamento com o responsável da venda.",
    });
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED", ownerId: org.ids.sellerA1 });
    const types = (await handle.db.select({ type: leadEvents.type }).from(leadEvents).where(eq(leadEvents.saleId, saleId))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["SALE_CREATED", "SALE_REVERSED", "SALE_REACTIVATED"]));
  });

  it("com outra venda válida, o lead continua em Fechamento", async () => {
    const { leadId, saleId, version } = await saleOfA1();
    await createSale(await ctx(org.ids.sellerA1), saleInput(leadId, course2));
    await as(org.ids.supA);
    expect(await actions.reverseSaleAction(IDLE, form({ saleId, expectedVersion: String(version), reason: "Duplicada" }))).toMatchObject({
      status: "success",
      message: "Venda estornada. O lead continua em Fechamento porque tem outra venda válida.",
    });
    expect(await leadRow(leadId)).toMatchObject({ stage: "CLOSED" });
  });

  it("casos bloqueados mostram a mensagem de negócio e não alteram nada", async () => {
    // 1) responsável transferido para outra equipe
    const moved = await insertUser(handle, { name: `Vendedor Movido ${++seq}`, role: "SELLER", teamId: org.ids.teamA });
    const leadMoved = await newLead(moved);
    const { saleId: saleMoved } = await createSale(await ctx(moved), saleInput(leadMoved, course));
    await changeSellerTeam(await ctx(org.ids.admin), moved, { teamId: org.ids.teamB });

    // 2) e 3) responsável ativo numa equipe que foi inativada (= equipe do lead inativa)
    const [teamC] = await handle.db.insert(teams).values({ name: `Equipe C ${++seq}` }).returning();
    const sellerC = await insertUser(handle, { name: `Vendedor C ${seq}`, role: "SELLER", teamId: teamC.id });
    const leadC = await newLead(sellerC);
    const { saleId: saleC } = await createSale(await ctx(sellerC), saleInput(leadC, course));
    await handle.db.update(teams).set({ active: false }).where(eq(teams.id, teamC.id));

    await as(org.ids.admin);
    for (const saleId of [saleMoved, saleC]) {
      const { version } = await getSale(await ctx(org.ids.admin), saleId);
      const result = await actions.reverseSaleAction(IDLE, form({ saleId, expectedVersion: String(version), reason: "Teste" }));
      expect(result).toMatchObject({ status: "error", message: REVERSAL_NEEDS_VALID_OWNER });
      expect(await saleRow(saleId)).toMatchObject({ status: "ACTIVE" });
    }
  });

  it("venda fora do escopo: inexistente", async () => {
    const { saleId, version } = await saleOfA1();
    await as(org.ids.supB);
    expect(await actions.reverseSaleAction(IDLE, form({ saleId, expectedVersion: String(version), reason: "x" }))).toMatchObject({
      status: "error",
      message: NOT_FOUND,
    });
  });
});

describe("leituras de apoio à tela", () => {
  it("nenhuma resposta de action carrega custo de bolsa", async () => {
    await as(org.ids.admin);
    const leadId = await newLead(org.ids.sellerA1);
    const result = await actions.createSaleAction(IDLE, form(createForm(leadId, { sellerId: org.ids.sellerA1 })));
    expect(JSON.stringify(result).toLowerCase()).not.toMatch(/cost|custo|profit|lucro/);
  });

  it("busca por nome do lead, nomes dos cursos e paginação no serviço", async () => {
    const seller = await insertUser(handle, { name: `Vendedor Busca ${++seq}`, role: "SELLER", teamId: org.ids.teamA });
    for (let i = 0; i < 3; i++) {
      const leadId = await newLead(seller, `Maria Busca ${i}`);
      await createSale(await ctx(seller), { ...saleInput(leadId, course), items: [{ courseId: course, priceCents: 100 }, { courseId: course2, priceCents: 200 }] });
    }
    const sellerCtx = await ctx(seller);
    const found = await listSales(sellerCtx, { search: "maria busca", pageSize: 25 });
    expect(found.total).toBe(3);
    expect(found.items[0]).toMatchObject({ itemCount: 2, totalCents: 300 });
    expect(found.items[0].courseNames.split(", ").sort()).toEqual(["Administração", "Pedagogia"]);
    expect(found.items[0]).not.toHaveProperty("costSnapshotCents");
    expect((await listSales(sellerCtx, { search: "%", pageSize: 25 })).total).toBe(0);
    expect((await listSales(sellerCtx, { search: "Busca 1" })).total).toBe(1);
    // Filtro de outro vendedor para o SELLER: o escopo continua valendo.
    expect((await listSales(sellerCtx, { sellerId: org.ids.sellerA1 })).total).toBe(0);
  });

  it("histórico com nomes resolvidos; custo de bolsa só para o ADMIN", async () => {
    const { saleId } = await saleOfA1();
    const forSup = await getSaleHistoryView(await ctx(org.ids.supA), saleId);
    expect(forSup.names).toMatchObject({ [org.ids.sellerA1]: "Vendedor A1", [org.ids.teamA]: "Equipe A", [course]: "Pedagogia" });
    expect(JSON.stringify(forSup)).not.toContain("costSnapshotCents");
    const forAdmin = await getSaleHistoryView(await ctx(org.ids.admin), saleId);
    expect(JSON.stringify(forAdmin)).toContain("costSnapshotCents");
    await expect(getSaleHistoryView(await ctx(org.ids.supB), saleId)).rejects.toThrow(NOT_FOUND);
  });

  it("vendedores oferecidos: SELLER só a própria equipe; SUPERVISOR e ADMIN, ativos de equipes ativas", async () => {
    const forSeller = await listSaleSellerOptions(await ctx(org.ids.sellerA1));
    expect(forSeller.every((s) => s.teamId === org.ids.teamA)).toBe(true);
    expect(forSeller.map((s) => s.id)).toEqual(expect.arrayContaining([org.ids.sellerA1, org.ids.sellerA2]));
    const forAdmin = await listSaleSellerOptions(await ctx(org.ids.admin));
    expect(forAdmin.map((s) => s.id)).toEqual(expect.arrayContaining([org.ids.sellerA1, org.ids.sellerB1]));
    const forSup = await listSaleSellerOptions(await ctx(org.ids.supA));
    expect(forSup.map((s) => s.id)).toContain(org.ids.sellerB1);
    // Equipe inativa (Equipe C do teste anterior) nunca aparece.
    const inactive = await handle.db.select({ id: teams.id }).from(teams).where(eq(teams.active, false));
    expect(forAdmin.some((s) => inactive.some((t) => t.id === s.teamId))).toBe(false);
  });
});
