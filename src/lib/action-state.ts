/** Resultado padronizado de toda Server Action consumida via useActionState. */
export type ActionState =
  | { status: "idle" }
  | { status: "success"; message: string; at: number }
  | { status: "error"; message: string; fieldErrors: Record<string, string[]>; at: number };

export type ServerAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

export const IDLE: ActionState = { status: "idle" };

export function fieldErrorsOf(state: ActionState): Record<string, string[]> {
  return state.status === "error" ? state.fieldErrors : {};
}
