"use client";

import { useActionState, useEffect, useRef } from "react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form";
import { fieldErrorsOf, IDLE } from "@/lib/action-state";
import { changePasswordAction } from "./actions";

export function ChangePasswordForm() {
  const [state, formAction] = useActionState(changePasswordAction, IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  const errors = fieldErrorsOf(state);

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4 px-5 py-5">
      <FormAlert
        tone={state.status === "success" ? "success" : "error"}
        message={state.status === "success" || (state.status === "error" && Object.keys(errors).length === 0) ? state.message : undefined}
      />
      <Field label="Senha atual" htmlFor="currentPassword" errors={errors.currentPassword}>
        <Input id="currentPassword" name="currentPassword" type="password" required autoComplete="current-password" />
      </Field>
      <Field label="Nova senha" htmlFor="newPassword" errors={errors.newPassword} hint="Mínimo de 8 caracteres.">
        <Input id="newPassword" name="newPassword" type="password" required minLength={8} autoComplete="new-password" />
      </Field>
      <Field label="Confirmar nova senha" htmlFor="confirmPassword" errors={errors.confirmPassword}>
        <Input id="confirmPassword" name="confirmPassword" type="password" required autoComplete="new-password" />
      </Field>
      <div className="flex justify-end">
        <SubmitButton>Alterar senha</SubmitButton>
      </div>
    </form>
  );
}
