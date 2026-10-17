import { INSTALLMENT_PAGE_SIZES, type InstallmentFilter, type InstallmentPageSize } from "@/lib/installments";

/**
 * Filtros e página da listagem de parcelas na URL. Valores inválidos são
 * ignorados; o serviço aplica escopo e validação de novo.
 */
export type InstallmentsParams = {
  q?: string;
  status?: InstallmentFilter;
  from?: string;
  to?: string;
  page: number;
  size: InstallmentPageSize;
};

type RawParams = Record<string, string | string[] | undefined>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const STATUS_SLUGS: Record<string, InstallmentFilter> = { abertas: "OPEN", vencidas: "OVERDUE", pagas: "PAID", canceladas: "CANCELED" };
export const slugOfStatus = (status: InstallmentFilter) => Object.keys(STATUS_SLUGS).find((k) => STATUS_SLUGS[k] === status)!;

function first(raw: RawParams, key: string): string | undefined {
  const value = raw[key];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || undefined;
}

function date(raw: RawParams, key: string): string | undefined {
  const value = first(raw, key);
  return value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

export function parseInstallmentsParams(raw: RawParams): InstallmentsParams {
  const page = Number(first(raw, "pagina"));
  const size = Number(first(raw, "por"));
  return {
    q: first(raw, "q")?.slice(0, 120),
    status: STATUS_SLUGS[first(raw, "situacao") ?? ""],
    from: date(raw, "de"),
    to: date(raw, "ate"),
    page: Number.isInteger(page) && page > 1 ? page : 1,
    size: (INSTALLMENT_PAGE_SIZES as readonly number[]).includes(size) ? (size as InstallmentPageSize) : INSTALLMENT_PAGE_SIZES[0],
  };
}

export function installmentsHref(params: InstallmentsParams, overrides: Partial<InstallmentsParams> = {}): string {
  const p = { ...params, ...overrides };
  const query = new URLSearchParams();
  if (p.q) query.set("q", p.q);
  if (p.status) query.set("situacao", slugOfStatus(p.status));
  if (p.from) query.set("de", p.from);
  if (p.to) query.set("ate", p.to);
  if (p.page > 1) query.set("pagina", String(p.page));
  if (p.size !== INSTALLMENT_PAGE_SIZES[0]) query.set("por", String(p.size));
  const text = query.toString();
  return text ? `/parcelas?${text}` : "/parcelas";
}

export function hasInstallmentFilters(p: InstallmentsParams): boolean {
  return !!(p.q || p.status || p.from || p.to);
}

/** URL → filtros do serviço. Período invertido é ignorado (a tela avisa). */
export function toInstallmentFilters(p: InstallmentsParams) {
  const inverted = !!(p.from && p.to && p.from > p.to);
  return {
    page: p.page,
    pageSize: p.size,
    search: p.q,
    status: p.status,
    dueFrom: inverted ? undefined : p.from,
    dueTo: inverted ? undefined : p.to,
  };
}
