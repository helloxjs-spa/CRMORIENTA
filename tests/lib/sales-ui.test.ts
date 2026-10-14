import { describe, expect, it } from "vitest";
import { saleActionsFor, saleEditCapabilities } from "@/app/(app)/vendas/policy";
import { parseSalesParams, salesHref, toSaleFilters } from "@/app/(app)/vendas/search-params";
import { describeSaleEvent } from "@/lib/sale-history";
import { formatSaleDate, paymentLabel, previewTotalCents } from "@/lib/sales";

const ids = {
  seller: "11111111-1111-4111-8111-111111111111",
  seller2: "22222222-2222-4222-8222-222222222222",
  team: "33333333-3333-4333-8333-333333333333",
  course: "44444444-4444-4444-8444-444444444444",
};
/** Intl usa espaço não separável depois de "R$". */
const plain = (lines: string[]) => lines.map((line) => line.replace(/ /g, " "));
const names = { [ids.seller]: "Ana", [ids.seller2]: "Bia", [ids.team]: "Equipe A", [ids.course]: "Pedagogia" };

describe("prévia do total no formulário", () => {
  it("soma em centavos, sem ponto flutuante", () => {
    expect(previewTotalCents(["0,10", "0,20"])).toBe(30);
    expect(previewTotalCents(["1.500,00", "R$ 999,90", "300"])).toBe(279_990);
    expect(previewTotalCents(Array.from({ length: 10 }, () => "0,10"))).toBe(100);
  });
  it("sem total enquanto houver preço vazio, inválido ou zero", () => {
    for (const bad of ["", "abc", "0", "0,00", "-5", "1,234"]) expect(previewTotalCents(["10,00", bad])).toBeNull();
    expect(previewTotalCents([])).toBe(0);
  });
});

describe("formatação", () => {
  it("data comercial sem fuso e pagamento por extenso", () => {
    expect(formatSaleDate("2026-01-02")).toBe("02/01/2026");
    expect(paymentLabel("PIX", null)).toBe("Pix (à vista)");
    expect(paymentLabel("CARD", 12)).toBe("Cartão em 12x");
  });
});

describe("histórico da venda", () => {
  it("CREATED com cursos e preços, sem custo mesmo se o metadata trouxer", () => {
    const text = describeSaleEvent(
      {
        type: "CREATED",
        reason: null,
        metadata: {
          sale: { sellerId: ids.seller, teamId: ids.team, totalCents: 150_000, paymentMethod: "CARD", installmentCount: 3 },
          items: [{ id: "x", courseId: ids.course, priceCents: 150_000, costSnapshotCents: 40_000 }],
        },
      },
      names,
    );
    expect(text.title).toBe("Venda registrada");
    expect(plain(text.lines)).toEqual(["Total: R$ 1.500,00 · Cartão em 3x", "Responsável: Ana · equipe Equipe A", "Curso: Pedagogia — R$ 1.500,00"]);
    expect(JSON.stringify(text)).not.toContain("400");
  });

  it("UPDATED descreve campos, itens incluídos, removidos e preços corrigidos", () => {
    const text = describeSaleEvent(
      {
        type: "UPDATED",
        reason: null,
        metadata: {
          changes: {
            totalCents: { from: 150_000, to: 120_000 },
            paymentMethod: { from: "PIX", to: "CARD" },
            installmentCount: { from: null, to: 2 },
            saleDate: { from: "2026-01-01", to: "2026-01-05" },
            sellerId: { from: ids.seller, to: ids.seller2 },
          },
          itemsAdded: [{ courseId: ids.course, priceCents: 20_000 }],
          itemsRemoved: [{ courseId: ids.course, priceCents: 50_000 }],
          itemsRepriced: [{ courseId: ids.course, from: 100_000, to: 100_000 - 1 }],
        },
      },
      names,
    );
    expect(plain(text.lines)).toEqual([
      "Total: R$ 1.500,00 → R$ 1.200,00",
      "Pagamento: Pix (à vista) → Cartão",
      "Parcelas: — → 2",
      "Data da venda: 01/01/2026 → 05/01/2026",
      "Responsável: Ana → Bia",
      "Curso incluído: Pedagogia — R$ 200,00",
      "Curso removido: Pedagogia — R$ 500,00",
      "Preço corrigido: Pedagogia — R$ 1.000,00 → R$ 999,99",
    ]);
  });

  it("estorno e reativação mostram o motivo; nome desconhecido não quebra", () => {
    expect(describeSaleEvent({ type: "REVERSED", reason: "Desistiu", metadata: {} }, {})).toEqual({ title: "Venda estornada", lines: [], quote: "Desistiu" });
    expect(describeSaleEvent({ type: "REACTIVATED", reason: "Pagou", metadata: {} }, {}).quote).toBe("Pagou");
    expect(describeSaleEvent({ type: "UPDATED", reason: null, metadata: { changes: { sellerId: { from: "?", to: null } } } }, {}).lines).toEqual([
      "Responsável: — → —",
    ]);
  });
});

describe("ações oferecidas pela interface", () => {
  it("SELLER: edita (só incluir) venda válida; nunca estorna/reativa; estornada é somente leitura", () => {
    expect(saleActionsFor({ status: "ACTIVE" }, { role: "SELLER" })).toEqual(["edit"]);
    expect(saleActionsFor({ status: "REVERSED" }, { role: "SELLER" })).toEqual([]);
    expect(saleEditCapabilities({ role: "SELLER" })).toEqual({ financial: false, changeSeller: false, setDate: false });
  });
  it("SUPERVISOR: financeiro e responsável, sem data; ADMIN: tudo", () => {
    expect(saleActionsFor({ status: "ACTIVE" }, { role: "SUPERVISOR" })).toEqual(["edit", "reverse"]);
    expect(saleActionsFor({ status: "REVERSED" }, { role: "SUPERVISOR" })).toEqual(["edit", "reactivate"]);
    expect(saleEditCapabilities({ role: "SUPERVISOR" })).toEqual({ financial: true, changeSeller: true, setDate: false });
    expect(saleEditCapabilities({ role: "ADMIN" })).toEqual({ financial: true, changeSeller: true, setDate: true });
  });
});

describe("filtros na URL", () => {
  it("lê, ignora valores inválidos e monta a URL de volta", () => {
    const params = parseSalesParams({
      q: " Maria ",
      situacao: "estornadas",
      pagamento: "cartao",
      de: "2026-01-01",
      ate: "2026-13-45",
      vendedor: ids.seller,
      equipe: "nao-e-uuid",
      pagina: "3",
      por: "50",
    });
    expect(params).toEqual({ q: "Maria", status: "REVERSED", payment: "CARD", from: "2026-01-01", to: undefined, seller: ids.seller, team: undefined, page: 3, size: 50 });
    expect(salesHref(params)).toBe(`/vendas?q=Maria&situacao=estornadas&vendedor=${ids.seller}&pagamento=cartao&de=2026-01-01&pagina=3&por=50`);
    expect(salesHref(params, { page: 1, size: 25, q: undefined, status: undefined, payment: undefined, from: undefined, seller: undefined })).toBe("/vendas");
    expect(parseSalesParams({ por: "7", pagina: "-1", situacao: "x" })).toMatchObject({ size: 25, page: 1, status: undefined });
  });
  it("vendedor e equipe só chegam ao serviço para quem pode filtrar por eles", () => {
    const params = parseSalesParams({ vendedor: ids.seller, equipe: ids.team });
    expect(toSaleFilters(params, { canFilterSeller: false, canFilterTeam: false })).toMatchObject({ sellerId: undefined, teamId: undefined });
    expect(toSaleFilters(params, { canFilterSeller: true, canFilterTeam: true })).toMatchObject({ sellerId: ids.seller, teamId: ids.team });
  });
});
