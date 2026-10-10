"use client";

import { useActionState, useEffect, useRef } from "react";
import { FormAlert, SubmitButton, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { fieldErrorsOf, IDLE, type ActionState } from "@/lib/action-state";
import { addLeadNoteAction } from "./actions";

/** Atualização do vendedor responsável (append-only; em Negociação renova o prazo). */
export function NoteForm({ leadId, renewsNegotiation }: { leadId: string; renewsNegotiation: boolean }) {
  const [state, formAction] = useActionState<ActionState, FormData>(addLeadNoteAction, IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (state.status === "success") {
      toast(state.message);
      formRef.current?.reset();
    }
  }, [state, toast]);

  const errors = fieldErrorsOf(state).body;
  return (
    <form ref={formRef} action={formAction} className="space-y-2">
      <input type="hidden" name="leadId" value={leadId} />
      <FormAlert message={state.status === "error" && !errors ? state.message : undefined} />
      <label htmlFor={`note-${leadId}`} className="sr-only">
        Adicionar atualização
      </label>
      <Textarea
        id={`note-${leadId}`}
        name="body"
        required
        maxLength={5000}
        rows={3}
        placeholder="Adicionar atualização..."
        aria-invalid={errors?.length ? true : undefined}
      />
      {errors?.map((error) => (
        <p key={error} className="text-xs font-medium text-red-600">
          {error}
        </p>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {renewsNegotiation
            ? "Em negociação: salvar uma atualização renova o prazo da negociação por mais 24 horas."
            : "As atualizações ficam no histórico e não podem ser editadas nem apagadas."}
        </p>
        <SubmitButton size="sm">Salvar atualização</SubmitButton>
      </div>
    </form>
  );
}
