import { SALE_PAGE_SIZES, type SalePageSize } from "@/lib/sales";
import type { PaymentMethod, SaleStatus } from "@/server/db/schema";

/**
 * Filtros e página da listagem de vendas na URL. Valores inválidos são
 * ignorados; o serviço aplica escopo e validação de novo.
 */
export type SalesParams = {
  q?: string;
  status?: SaleStatus;
  seller?: string;
  team?: string;
  payment?: PaymentMethod;
  from?: string;
  to?: string;
  page: number;
  size: SalePageSize;
};

type RawParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_SLUGS: Record<string, SaleStatus> = { validas: "ACTIVE", estornadas: "REVERSED" };
const PAYMENT_SLUGS: Record<string, PaymentMethod> = { pix: "PIX", cartao: "CARD" };
const slugOf = <T extends string>(map: Record<string, T>, value: T) => Object.keys(map).find((k) => map[k] === value);

function first(raw: RawParams, key: string): string | undefined {
  const value = raw[key];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || undefined;
}

function uuid(raw: RawParams, key: string): string | undefined {
  const value = first(raw, key);
  return value && UUID.test(value) ? value : undefined;
}

function date(raw: RawParams, key: string): string | undefined {
  const value = first(raw, key);
  return value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

export function parseSalesParams(raw: RawParams): SalesParams {
  const page = Number(first(raw, "pagina"));
  const size = Number(first(raw, "por"));
  return {
    q: first(raw, "q")?.slice(0, 120),
    status: STATUS_SLUGS[first(raw, "situacao") ?? ""],
    seller: uuid(raw, "vendedor"),
    team: uuid(raw, "equipe"),
    payment: PAYMENT_SLUGS[first(raw, "pagamento") ?? ""],
    from: date(raw, "de"),
    to: date(raw, "ate"),
    page: Number.isInteger(page) && page > 1 ? page : 1,
    size: (SALE_PAGE_SIZES as readonly number[]).includes(size) ? (size as SalePageSize) : SALE_PAGE_SIZES[0],
  };
}

export function salesHref(params: SalesParams, overrides: Partial<SalesParams> = {}): string {
  const p = { ...params, ...overrides };
  const query = new URLSearchParams();
  if (p.q) query.set("q", p.q);
  if (p.status) query.set("situacao", slugOf(STATUS_SLUGS, p.status)!);
  if (p.seller) query.set("vendedor", p.seller);
  if (p.team) query.set("equipe", p.team);
  if (p.payment) query.set("pagamento", slugOf(PAYMENT_SLUGS, p.payment)!);
  if (p.from) query.set("de", p.from);
  if (p.to) query.set("ate", p.to);
  if (p.page > 1) query.set("pagina", String(p.page));
  if (p.size !== SALE_PAGE_SIZES[0]) query.set("por", String(p.size));
  const text = query.toString();
  return text ? `/vendas?${text}` : "/vendas";
}

export function hasSaleFilters(p: SalesParams): boolean {
  return !!(p.q || p.status || p.seller || p.team || p.payment || p.from || p.to);
}

/** URL → filtros do serviço. Vendedor/equipe só para quem pode filtrar por eles. */
export function toSaleFilters(p: SalesParams, { canFilterSeller, canFilterTeam }: { canFilterSeller: boolean; canFilterTeam: boolean }) {
  return {
    page: p.page,
    pageSize: p.size,
    search: p.q,
    status: p.status,
    sellerId: canFilterSeller ? p.seller : undefined,
    teamId: canFilterTeam ? p.team : undefined,
    paymentMethod: p.payment,
    dateFrom: p.from,
    dateTo: p.to,
  };
}

export { STATUS_SLUGS, PAYMENT_SLUGS };
