/**
 * Parcelas (§12; decisão C52): regras puras usadas pelo serviço e pela tela.
 * O banco (006_installments.sql) confere no COMMIT exatamente esta regra.
 */

/**
 * Teto TÉCNICO de parcelas por venda (não é regra comercial; ver
 * docs/ARQUITETURA.md, "Decisões técnicas"). O cronograma é gravado num único
 * INSERT (5 parâmetros por parcela; o protocolo do PostgreSQL aceita até 65.535)
 * e exibido inteiro no detalhe da venda. Vale na criação e quando a quantidade
 * é alterada; vendas antigas acima dele não são bloqueadas em outras edições.
 */
export const MAX_INSTALLMENTS = 1_000;

export const INSTALLMENT_PAGE_SIZES = [25, 50, 100] as const;
export type InstallmentPageSize = (typeof INSTALLMENT_PAGE_SIZES)[number];

export const INSTALLMENT_STATUS_LABELS = { OPEN: "Em aberto", PAID: "Paga", CANCELED: "Cancelada" } as const;

/** Filtro de situação da lista. "Vencidas" = em aberto com vencimento antes de hoje (só exibição). */
export const INSTALLMENT_FILTERS = ["OPEN", "OVERDUE", "PAID", "CANCELED"] as const;
export type InstallmentFilter = (typeof INSTALLMENT_FILTERS)[number];

export const INSTALLMENT_FILTER_LABELS: Record<InstallmentFilter, string> = {
  OPEN: "Em aberto",
  OVERDUE: "Vencidas",
  PAID: "Pagas",
  CANCELED: "Canceladas",
};

export type ScheduledInstallment = { number: number; amountCents: number; dueDate: string };

/**
 * "AAAA-MM-DD" + `months` meses, no mesmo dia; se o mês de destino não tem o
 * dia, o último dia dele (igual a `date + interval 'n months'` do PostgreSQL).
 */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/**
 * Cronograma do cartão (C52): `count` parcelas; a n-ésima vence `n` meses após
 * a data da venda; valor = total ÷ quantidade, com os centavos que sobram na
 * 1ª parcela (a soma é sempre o total).
 */
export function buildInstallmentSchedule(saleDate: string, totalCents: number, count: number): ScheduledInstallment[] {
  const share = Math.floor(totalCents / count);
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    amountCents: i === 0 ? totalCents - (count - 1) * share : share,
    dueDate: addMonths(saleDate, i + 1),
  }));
}
