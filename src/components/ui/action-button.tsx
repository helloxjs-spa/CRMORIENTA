"use client";

import { useActionState, useEffect, type ReactNode } from "react";
import { IDLE, type ActionState, type ServerAction } from "@/lib/action-state";
import type { ButtonVariant } from "./button";
import { SubmitButton } from "./form";
import { useToast } from "./toast";

/**
 * Botão que dispara uma Server Action sem formulário visível (ex.: ativar /
 * desativar). Os valores vão em campos ocultos e são revalidados no servidor.
 */
export function ActionButton({
  action,
  fields,
  confirm,
  variant = "secondary",
  children,
}: {
  action: ServerAction;
  fields: Record<string, string>;
  confirm?: string;
  variant?: ButtonVariant;
  children: ReactNode;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, IDLE);
  const toast = useToast();

  useEffect(() => {
    if (state.status !== "idle") toast(state.message, state.status);
  }, [state, toast]);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton variant={variant} size="sm">
        {children}
      </SubmitButton>
    </form>
  );
}
