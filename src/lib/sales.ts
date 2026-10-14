import type { PaymentMethod, SaleStatus } from "@/server/db/schema";
import type { ActionState } from "./action-state";
import { parseBRLToCents } from "./money";

/** Tamanhos de página da listagem de vendas (mesmos da listagem de leads). */
export const SALE_PAGE_SIZES = [25, 50, 100] as const;
export type SalePageSize = (typeof SALE_PAGE_SIZES)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  PIX: "Pix (à vista)",
  CARD: "Cartão",
};

export const SALE_STATUS_LABELS: Record<SaleStatus, string> = {
  ACTIVE: "Válida",
  REVERSED: "Estornada",
};

/**
 * Conflito de versão: a venda mudou desde a leitura (pode ter sido outra aba,
 * outra pessoa ou um envio anterior cuja resposta não chegou). A tela oferece
 * atualizar a venda, nunca reenvia.
 */
export const SALE_CHANGED_CONCURRENTLY =
  "Esta venda mudou desde que você abriu esta tela e nada foi gravado agora. Atualize a venda para ver a versão atual antes de tentar de novo.";

/** Mesmo `requestId` com outros dados: nada é gravado e não é sucesso. Nunca sugere gerar outra chave. */
export const REQUEST_ID_REUSED =
  "Esta tentativa de registro já foi usada com outros dados e nada foi gravado agora. Confira as vendas do lead antes de decidir começar uma nova venda.";

/** A resposta do registro não chegou: a venda pode ou não ter sido gravada. */
export const SALE_CREATE_UNCERTAIN =
  "Não foi possível confirmar se a venda foi registrada: a resposta do servidor não chegou. Os dados e a identificação desta tentativa foram mantidos; enviar de novo sem alterar nada não duplica a venda.";

/** A resposta do estorno/reativação não chegou: o resultado precisa ser conferido. */
export const SALE_STATUS_UNCERTAIN =
  "Não foi possível confirmar o resultado: a resposta do servidor não chegou. Atualize a venda e confira a situação e o histórico antes de tentar de novo.";

/** Erro do estorno/reativação que exige atualizar a venda antes de nova tentativa. */
export function saleStatusAlert(state: ActionState): "conflict" | "uncertain" | null {
  if (state.status !== "error") return null;
  if (state.message === SALE_CHANGED_CONCURRENTLY) return "conflict";
  if (state.message === SALE_STATUS_UNCERTAIN) return "uncertain";
  return null;
}

/** Forma de pagamento por extenso, com parcelas no cartão. */
export function paymentLabel(method: PaymentMethod, installments: number | null): string {
  return method === "CARD" ? `Cartão em ${installments ?? "?"}x` : PAYMENT_METHOD_LABELS.PIX;
}

/** Data comercial "AAAA-MM-DD" → "DD/MM/AAAA" (sem passar por fuso horário). */
export function formatSaleDate(date: string): string {
  const [y, m, d] = date.split("-");
  return y && m && d ? `${d}/${m}/${y}` : date;
}

/**
 * Total exibido no formulário: soma, em centavos, dos preços digitados em
 * reais. null enquanto algum preço estiver vazio, inválido ou não for maior
 * que zero (o servidor recalcula e valida de novo; isto é só a prévia).
 */
export function previewTotalCents(prices: string[]): number | null {
  let total = 0;
  for (const price of prices) {
    const cents = parseBRLToCents(price);
    if (cents === null || cents <= 0) return null;
    total += cents;
  }
  return total;
}
