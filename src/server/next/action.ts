import "server-only";
import type { ActionState } from "@/lib/action-state";
import type { ServiceContext } from "@/server/context";
import { AppError, ValidationError } from "@/server/errors";
import { requireServiceContext } from "./session";

/**
 * Envelope de toda Server Action autenticada:
 * 1. Revalida a sessão no banco (Server Actions são endpoints públicos).
 * 2. Executa o serviço, que aplica RBAC + escopo + validação.
 * 3. Converte erros de domínio em ActionState para a interface; erros
 *    inesperados são logados e nunca têm detalhes expostos ao cliente.
 */
/** Sucesso com destino: a tela navega para `redirectTo` (ex.: a venda criada). */
export type ActionResult = { message: string; redirectTo?: string };

export async function runAction(fn: (ctx: ServiceContext) => Promise<string | ActionResult>): Promise<ActionState> {
  const ctx = await requireServiceContext();
  try {
    const result = await fn(ctx);
    if (typeof result === "string") return { status: "success", message: result, at: Date.now() };
    return { status: "success", message: result.message, redirectTo: result.redirectTo, at: Date.now() };
  } catch (error) {
    return toErrorState(error);
  }
}

export function toErrorState(error: unknown): ActionState {
  if (error instanceof AppError) {
    return {
      status: "error",
      message: error.message,
      fieldErrors: error instanceof ValidationError ? error.fieldErrors : {},
      at: Date.now(),
    };
  }
  console.error("[action] erro inesperado", error);
  return { status: "error", message: "Erro inesperado. Tente novamente.", fieldErrors: {}, at: Date.now() };
}

/** Lê um campo de texto do FormData (somente campos explicitamente lidos chegam ao serviço). */
export function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Campo opcional: string vazia vira null. */
export function optionalText(formData: FormData, name: string): string | null {
  return text(formData, name) || null;
}
