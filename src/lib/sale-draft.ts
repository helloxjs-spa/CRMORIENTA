import type { PaymentMethod } from "@/server/db/schema";

/**
 * Rascunho da venda em registro, guardado no `sessionStorage` da aba: um F5
 * recupera os dados digitados e o MESMO `requestId`, então reenviar não cria
 * outra venda (o servidor devolve a já gravada). Vale só para esta aba e este
 * navegador: outra aba ou outro dispositivo tem outra tentativa. A
 * idempotência continua sendo do servidor; o rascunho só evita perder a chave.
 */

/** Validade do rascunho: decisão técnica provisória (não é regra de negócio). */
export const SALE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_ROWS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_VALUES = ["", "PIX", "CARD"] as const;

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type SaleDraftFields = {
  items: { courseId: string; price: string }[];
  paymentMethod: PaymentMethod | "";
  installmentCount: string;
  sellerId: string;
  saleDate: string;
};

export type SaleDraft = {
  version: 1;
  actorId: string;
  leadId: string;
  requestId: string;
  /** Epoch em ms de quando a tentativa (o requestId) foi criada. */
  createdAt: number;
  /** Já houve envio desta tentativa sem confirmação de sucesso. */
  submitted: boolean;
  fields: SaleDraftFields;
};

export const saleDraftKey = (actorId: string, leadId: string) => `crm:sale-draft:${actorId}:${leadId}`;

/** `sessionStorage` da aba, ou null se indisponível (servidor, bloqueado pelo navegador). */
export function sessionDraftStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function emptySaleDraftFields(sellerId: string): SaleDraftFields {
  return { items: [{ courseId: "", price: "" }], paymentMethod: "", installmentCount: "", sellerId, saleDate: "" };
}

export function newSaleDraft(actorId: string, leadId: string, requestId: string, fields: SaleDraftFields, now = Date.now()): SaleDraft {
  return { version: 1, actorId, leadId, requestId, createdAt: now, submitted: false, fields };
}

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

function parseFields(value: unknown): SaleDraftFields | null {
  if (typeof value !== "object" || value === null) return null;
  const f = value as Record<string, unknown>;
  if (!Array.isArray(f.items) || f.items.length === 0 || f.items.length > MAX_ROWS) return null;
  const items: SaleDraftFields["items"] = [];
  for (const item of f.items as unknown[]) {
    if (typeof item !== "object" || item === null) return null;
    const { courseId, price } = item as Record<string, unknown>;
    if (!isText(courseId, 36) || !isText(price, 32)) return null;
    items.push({ courseId, price });
  }
  if (!PAYMENT_VALUES.includes(f.paymentMethod as (typeof PAYMENT_VALUES)[number])) return null;
  if (!isText(f.installmentCount, 10) || !isText(f.sellerId, 36) || !isText(f.saleDate, 10)) return null;
  return {
    items,
    paymentMethod: f.paymentMethod as SaleDraftFields["paymentMethod"],
    installmentCount: f.installmentCount,
    sellerId: f.sellerId,
    saleDate: f.saleDate,
  };
}

function parseDraft(raw: string): SaleDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const d = value as Record<string, unknown>;
  if (d.version !== 1 || typeof d.actorId !== "string" || typeof d.leadId !== "string") return null;
  if (typeof d.requestId !== "string" || !UUID.test(d.requestId)) return null;
  if (typeof d.createdAt !== "number" || !Number.isFinite(d.createdAt) || typeof d.submitted !== "boolean") return null;
  const fields = parseFields(d.fields);
  if (!fields) return null;
  return { version: 1, actorId: d.actorId, leadId: d.leadId, requestId: d.requestId, createdAt: d.createdAt, submitted: d.submitted, fields };
}

/**
 * Rascunho deste usuário para este lead, se válido e dentro da validade.
 * Inválido, expirado ou de outro usuário/lead → descartado (nunca reutilizado).
 */
export function readSaleDraft(storage: DraftStorage, actorId: string, leadId: string, now = Date.now()): SaleDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(saleDraftKey(actorId, leadId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  const draft = parseDraft(raw);
  if (draft && draft.actorId === actorId && draft.leadId === leadId && draft.createdAt <= now && now - draft.createdAt < SALE_DRAFT_TTL_MS) {
    return draft;
  }
  clearSaleDraft(storage, actorId, leadId);
  return null;
}

/** Grava o rascunho. false = não foi possível (cota, armazenamento bloqueado). */
export function writeSaleDraft(storage: DraftStorage, draft: SaleDraft): boolean {
  try {
    storage.setItem(saleDraftKey(draft.actorId, draft.leadId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearSaleDraft(storage: DraftStorage, actorId: string, leadId: string): void {
  try {
    storage.removeItem(saleDraftKey(actorId, leadId));
  } catch {
    // Sem acesso ao armazenamento: nada a limpar.
  }
}

/**
 * Campos recuperados ajustados às opções atuais da tela: curso que não está
 * mais disponível vira "Selecione", vendedor fora da lista volta ao padrão,
 * data só para quem pode informá-la. O servidor valida tudo de novo.
 */
export function restoreSaleDraftFields(
  fields: SaleDraftFields,
  options: { courseIds: string[]; sellerIds: string[]; defaultSellerId: string; canSetDate: boolean },
): SaleDraftFields {
  return {
    items: fields.items.map((item) => ({ courseId: options.courseIds.includes(item.courseId) ? item.courseId : "", price: item.price })),
    paymentMethod: fields.paymentMethod,
    installmentCount: fields.paymentMethod === "CARD" ? fields.installmentCount : "",
    sellerId: options.sellerIds.includes(fields.sellerId) ? fields.sellerId : options.defaultSellerId,
    saleDate: options.canSetDate ? fields.saleDate : "",
  };
}
