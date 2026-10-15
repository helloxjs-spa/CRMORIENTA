/**
 * Dashboard comercial (§17): regras puras usadas pelo serviço e pela tela.
 */

/**
 * Conversão (decisões do cliente C47 e #28): leads cadastrados no período com
 * pelo menos uma venda válida ÷ leads cadastrados no período que não estão na
 * Lixeira × 100. Sem leads elegíveis → null ("Indisponível"), nunca 0%.
 */
export function conversionRate(converted: number, eligible: number): number | null {
  return eligible > 0 ? (converted / eligible) * 100 : null;
}

/**
 * Variação percentual sobre o mês anterior. Sem base comparável (mês anterior
 * zerado ou negativo, ex.: lucro negativo) → null ("Indisponível").
 */
export function percentChange(current: number, previous: number): number | null {
  return previous > 0 ? ((current - previous) / previous) * 100 : null;
}

/** `count` meses terminando em `endMonth` ("AAAA-MM"), do mais antigo ao mais recente. */
export function lastMonths(endMonth: string, count: number): string[] {
  const [y, m] = endMonth.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

const SHORT_MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "2026-10" → "out/2026". */
export function shortMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${SHORT_MONTHS[m - 1]}/${y}`;
}

/** Percentual com uma casa decimal, ou "Indisponível". */
export function formatPercent(value: number | null, { signed = false } = {}): string {
  if (value === null) return "Indisponível";
  const text = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(value));
  if (!signed) return `${text}%`;
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text}%`;
}
