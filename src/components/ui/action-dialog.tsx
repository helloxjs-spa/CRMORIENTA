"use client";

import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { fieldErrorsOf, IDLE, type ActionState, type ServerAction } from "@/lib/action-state";
import { Button, type ButtonVariant } from "./button";
import { FormAlert, SubmitButton } from "./form";
import { useToast } from "./toast";

type Trigger = { label: string; icon?: LucideIcon; variant?: ButtonVariant; size?: "sm" | "md" };

/**
 * Modal com formulário ligado a uma Server Action. Fecha e mostra um toast em
 * caso de sucesso; exibe erros gerais e por campo em caso de falha.
 * `children` recebe os erros por campo para renderizá-los junto aos inputs.
 */
export function ActionDialog({
  trigger,
  title,
  description,
  action,
  submitLabel = "Salvar",
  submitVariant = "primary",
  children,
}: {
  trigger: Trigger;
  title: string;
  description?: string;
  action: ServerAction;
  submitLabel?: string;
  submitVariant?: ButtonVariant;
  children: (fieldErrors: Record<string, string[]>) => ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Cada abertura remonta o formulário, limpando valores e erros anteriores.
  const [session, setSession] = useState(0);
  const Icon = trigger.icon;

  const open = () => {
    setSession((s) => s + 1);
    dialogRef.current?.showModal();
  };
  const close = () => dialogRef.current?.close();

  return (
    <>
      <Button variant={trigger.variant ?? "primary"} size={trigger.size} onClick={open}>
        {Icon && <Icon className="size-4" aria-hidden />}
        {trigger.label}
      </Button>
      <dialog
        ref={dialogRef}
        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl bg-white p-0 shadow-xl ring-1 ring-slate-200"
        aria-labelledby={`dialog-title-${title}`}
      >
        {session > 0 && (
          <DialogForm
            key={session}
            title={title}
            description={description}
            action={action}
            submitLabel={submitLabel}
            submitVariant={submitVariant}
            onClose={close}
          >
            {children}
          </DialogForm>
        )}
      </dialog>
    </>
  );
}

function DialogForm({
  title,
  description,
  action,
  submitLabel,
  submitVariant,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  action: ServerAction;
  submitLabel: string;
  submitVariant: ButtonVariant;
  onClose: () => void;
  children: (fieldErrors: Record<string, string[]>) => ReactNode;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, IDLE);
  const toast = useToast();

  useEffect(() => {
    if (state.status === "success") {
      toast(state.message);
      onClose();
    }
  }, [state, toast, onClose]);

  return (
    <form action={formAction}>
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
        <div>
          <h2 id={`dialog-title-${title}`} className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Fechar">
          <X className="size-5" />
        </button>
      </div>
      <div className="space-y-4 px-6 py-5">
        <FormAlert message={state.status === "error" && Object.keys(state.fieldErrors).length === 0 ? state.message : undefined} />
        {children(fieldErrorsOf(state))}
      </div>
      <div className="flex justify-end gap-2 rounded-b-2xl border-t border-slate-100 bg-slate-50 px-6 py-3">
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
        <SubmitButton variant={submitVariant}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
