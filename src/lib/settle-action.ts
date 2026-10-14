import { unstable_rethrow } from "next/navigation";
import type { ActionState, ServerAction } from "./action-state";

/**
 * Chama a Server Action no cliente e transforma a falha de transporte (ex.:
 * resposta perdida na rede) em erro com `uncertainMessage`: a operação pode
 * ou não ter sido gravada, e a tela não deve afirmar nem sucesso nem falha.
 * Sem isso a exceção iria para o error boundary e o formulário se perderia.
 * Redirecionamentos e erros internos do Next continuam sendo propagados.
 */
export async function settleAction(action: ServerAction, prev: ActionState, formData: FormData, uncertainMessage: string): Promise<ActionState> {
  try {
    return await action(prev, formData);
  } catch (error) {
    unstable_rethrow(error);
    return { status: "error", message: uncertainMessage, fieldErrors: {}, at: Date.now() };
  }
}
