"use client";

import { useActionState } from "react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form";
import { fieldErrorsOf, IDLE } from "@/lib/action-state";
import { loginAction } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(loginAction, IDLE);
  const errors = fieldErrorsOf(state);

  return (
    <form action={formAction} className="mt-8 space-y-5">
      <input type="hidden" name="next" value={next} />
      <FormAlert message={state.status === "error" ? state.message : undefined} />
      <Field label="E-mail" htmlFor="email" errors={errors.email}>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus aria-invalid={!!errors.email} />
      </Field>
      <Field label="Senha" htmlFor="password" errors={errors.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required aria-invalid={!!errors.password} />
      </Field>
      <SubmitButton className="w-full" pending={pending}>
        {pending ? "Entrando..." : "Entrar"}
      </SubmitButton>
    </form>
  );
}
