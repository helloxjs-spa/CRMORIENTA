import { CERTIFICATE_PAGE_SIZES, type CertificateDateField, type CertificatePageSize } from "@/lib/certificates";

/**
 * Filtros e página da listagem de certificados na URL. Valores inválidos são
 * ignorados; o serviço aplica escopo e validação de novo.
 */
export type CertificatesParams = {
  q?: string;
  /** Data do período: conclusão ou entrega (padrão). */
  field: CertificateDateField;
  from?: string;
  to?: string;
  page: number;
  size: CertificatePageSize;
};

type RawParams = Record<string, string | string[] | undefined>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const FIELD_SLUGS: Record<string, CertificateDateField> = { conclusao: "completed", entrega: "delivered" };
const slugOf = (field: CertificateDateField) => Object.keys(FIELD_SLUGS).find((k) => FIELD_SLUGS[k] === field)!;

function first(raw: RawParams, key: string): string | undefined {
  const value = raw[key];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || undefined;
}

function date(raw: RawParams, key: string): string | undefined {
  const value = first(raw, key);
  return value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

export function parseCertificatesParams(raw: RawParams): CertificatesParams {
  const page = Number(first(raw, "pagina"));
  const size = Number(first(raw, "por"));
  return {
    q: first(raw, "q")?.slice(0, 120),
    field: FIELD_SLUGS[first(raw, "periodo") ?? ""] ?? "delivered",
    from: date(raw, "de"),
    to: date(raw, "ate"),
    page: Number.isInteger(page) && page > 1 ? page : 1,
    size: (CERTIFICATE_PAGE_SIZES as readonly number[]).includes(size) ? (size as CertificatePageSize) : CERTIFICATE_PAGE_SIZES[0],
  };
}

export function certificatesHref(params: CertificatesParams, overrides: Partial<CertificatesParams> = {}): string {
  const p = { ...params, ...overrides };
  const query = new URLSearchParams();
  if (p.q) query.set("q", p.q);
  if (p.field !== "delivered") query.set("periodo", slugOf(p.field));
  if (p.from) query.set("de", p.from);
  if (p.to) query.set("ate", p.to);
  if (p.page > 1) query.set("pagina", String(p.page));
  if (p.size !== CERTIFICATE_PAGE_SIZES[0]) query.set("por", String(p.size));
  const text = query.toString();
  return text ? `/certificados?${text}` : "/certificados";
}

export function hasCertificateFilters(p: CertificatesParams): boolean {
  return !!(p.q || p.from || p.to);
}

/** URL → filtros do serviço. Período invertido é ignorado (a tela avisa). */
export function toCertificateFilters(p: CertificatesParams) {
  const inverted = !!(p.from && p.to && p.from > p.to);
  return {
    page: p.page,
    pageSize: p.size,
    search: p.q,
    dateField: p.field,
    dateFrom: inverted ? undefined : p.from,
    dateTo: inverted ? undefined : p.to,
  };
}
