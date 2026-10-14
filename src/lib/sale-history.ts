import type { PaymentMethod, SaleEventType } from "@/server/db/schema";
import { formatBRL } from "./money";
import { formatSaleDate, PAYMENT_METHOD_LABELS } from "./sales";

/**
 * Texto de cada evento do histórico da venda, montado SÓ a partir do
 * metadata calculado pelo banco (sale_events) e dos nomes resolvidos pelo
 * serviço. Custos de bolsa nunca são exibidos aqui (para quem não é ADMIN o
 * serviço já os remove).
 */
export type SaleHistoryText = { title: string; lines: string[]; quote?: string };

type Names = Record<string, string>;
type Change = { from?: unknown; to?: unknown };
type ItemSnapshot = { id?: string; courseId?: string; priceCents?: number };
type Reprice = { courseId?: string; from?: number; to?: number };

const money = (value: unknown) => (typeof value === "number" ? formatBRL(value) : "—");
const nameOf = (names: Names, id: unknown, fallback = "—") => (typeof id === "string" ? (names[id] ?? fallback) : fallback);

function payment(value: unknown): string {
  return value === "PIX" || value === "CARD" ? PAYMENT_METHOD_LABELS[value as PaymentMethod] : "—";
}

function changeLines(changes: Record<string, Change>, names: Names): string[] {
  const lines: string[] = [];
  const c = (key: string) => changes[key];
  if (c("totalCents")) lines.push(`Total: ${money(c("totalCents").from)} → ${money(c("totalCents").to)}`);
  if (c("paymentMethod")) lines.push(`Pagamento: ${payment(c("paymentMethod").from)} → ${payment(c("paymentMethod").to)}`);
  if (c("installmentCount")) lines.push(`Parcelas: ${c("installmentCount").from ?? "—"} → ${c("installmentCount").to ?? "—"}`);
  if (c("saleDate")) {
    const d = (v: unknown) => (typeof v === "string" ? formatSaleDate(v) : "—");
    lines.push(`Data da venda: ${d(c("saleDate").from)} → ${d(c("saleDate").to)}`);
  }
  if (c("sellerId")) lines.push(`Responsável: ${nameOf(names, c("sellerId").from)} → ${nameOf(names, c("sellerId").to)}`);
  if (c("teamId")) lines.push(`Equipe: ${nameOf(names, c("teamId").from)} → ${nameOf(names, c("teamId").to)}`);
  if (c("supervisorId")) lines.push(`Supervisor: ${nameOf(names, c("supervisorId").from)} → ${nameOf(names, c("supervisorId").to)}`);
  return lines;
}

const itemLine = (names: Names, item: ItemSnapshot) => `${nameOf(names, item.courseId, "Curso")} — ${money(item.priceCents)}`;

export function describeSaleEvent(
  event: { type: SaleEventType; reason: string | null; metadata: Record<string, unknown> },
  names: Names,
): SaleHistoryText {
  const m = event.metadata;
  switch (event.type) {
    case "CREATED": {
      const sale = (m.sale ?? {}) as Record<string, unknown>;
      const items = (m.items ?? []) as ItemSnapshot[];
      const pay = sale.paymentMethod === "CARD" ? `Cartão em ${sale.installmentCount}x` : payment(sale.paymentMethod);
      return {
        title: "Venda registrada",
        lines: [
          `Total: ${money(sale.totalCents)} · ${pay}`,
          `Responsável: ${nameOf(names, sale.sellerId)} · equipe ${nameOf(names, sale.teamId)}`,
          ...items.map((item) => `Curso: ${itemLine(names, item)}`),
        ],
      };
    }
    case "UPDATED": {
      const added = (m.itemsAdded ?? []) as ItemSnapshot[];
      const removed = (m.itemsRemoved ?? []) as ItemSnapshot[];
      const repriced = (m.itemsRepriced ?? []) as Reprice[];
      return {
        title: "Venda alterada",
        lines: [
          ...changeLines((m.changes ?? {}) as Record<string, Change>, names),
          ...added.map((item) => `Curso incluído: ${itemLine(names, item)}`),
          ...removed.map((item) => `Curso removido: ${itemLine(names, item)}`),
          ...repriced.map((r) => `Preço corrigido: ${nameOf(names, r.courseId, "Curso")} — ${money(r.from)} → ${money(r.to)}`),
        ],
      };
    }
    case "REVERSED":
      return { title: "Venda estornada", lines: [], quote: event.reason ?? undefined };
    case "REACTIVATED":
      return { title: "Venda reativada", lines: [], quote: event.reason ?? undefined };
  }
}
