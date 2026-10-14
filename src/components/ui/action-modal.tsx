"use client";

import { X } from "lucide-react";
import { useActionState, useEffect, useId, useRef, type ReactNode } from "react";
import { fieldErrorsOf, IDLE, type ActionState, type ServerAction } from "@/lib/action-state";
import { Button, type ButtonVariant } from "./button";
import { FormAlert, SubmitButton } from "./form";
import { useToast } from "./toast";

/**
 * Modal com formulário ligado a uma Server Action, aberto por quem o usa
 * (ex.: um item de menu). Igual ao ActionDialog, mas sem botão próprio.
 * Cada abertura remonta o formulário (erros e valores limpos).
 * `renderAlert` (opcional) substitui o aviso de erro padrão quando devolve
 * algo; nesse caso o botão de envio some (nova tentativa só depois do que o
 * aviso pedir, ex.: atualizar os dados).
 */
export function ActionModal({
  open,
  onClose,
  title,
  description,
  action,
  submitLabel = "Salvar",
  submitVariant = "primary",
  renderAlert,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  action: ServerAction;
  submitLabel?: string;
  submitVariant?: ButtonVariant;
  renderAlert?: (state: ActionState) => ReactNode;
  children: (fieldErrors: Record<string, string[]>) => ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl bg-white p-0 shadow-xl ring-1 ring-slate-200"
      aria-labelledby={titleId}
    >
      {open && (
        <ModalForm
          titleId={titleId}
          title={title}
          description={description}
          action={action}
          submitLabel={submitLabel}
          submitVariant={submitVariant}
          renderAlert={renderAlert}
          onClose={onClose}
        >
          {children}
        </ModalForm>
      )}
    </dialog>
  );
}

function ModalForm({
  titleId,
  title,
  description,
  action,
  submitLabel,
  submitVariant,
  renderAlert,
  onClose,
  children,
}: {
  titleId: string;
  title: string;
  description?: ReactNode;
  action: ServerAction;
  submitLabel: string;
  submitVariant: ButtonVariant;
  renderAlert?: (state: ActionState) => ReactNode;
  onClose: () => void;
  children: (fieldErrors: Record<string, string[]>) => ReactNode;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, IDLE);
  const toast = useToast();
  const alert = renderAlert?.(state);

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
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          {description && <div className="mt-1 text-sm text-slate-500">{description}</div>}
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Fechar">
          <X className="size-5" />
        </button>
      </div>
      <div className="space-y-4 px-6 py-5">
        {alert || <FormAlert message={state.status === "error" && Object.keys(state.fieldErrors).length === 0 ? state.message : undefined} />}
        {children(fieldErrorsOf(state))}
      </div>
      <div className="flex justify-end gap-2 rounded-b-2xl border-t border-slate-100 bg-slate-50 px-6 py-3">
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
        {!alert && <SubmitButton variant={submitVariant}>{submitLabel}</SubmitButton>}
      </div>
    </form>
  );
}
