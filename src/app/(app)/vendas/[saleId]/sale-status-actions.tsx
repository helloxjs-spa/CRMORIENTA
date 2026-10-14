"use client";

import { Redo2, RefreshCw, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { ActionModal } from "@/components/ui/action-modal";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/form";
import type { ActionState } from "@/lib/action-state";
import { saleStatusAlert, SALE_STATUS_UNCERTAIN } from "@/lib/sales";
import { settleAction } from "@/lib/settle-action";
import { reactivateSaleAction, reverseSaleAction } from "../actions";

/**
 * Estorno e reativação: confirmação explícita em modal, motivo obrigatório e
 * a versão lida na página (expectedVersion). Em conflito de versão ou resposta
 * perdida, o modal pede para atualizar a venda (fecha e recarrega os dados e a
 * versão); o botão só volta depois disso e nada é reenviado sozinho.
 */
export function SaleStatusActions({ saleId, version, mode }: { saleId: string; version: number; mode: "reverse" | "reactivate" }) {
  const [open, setOpen] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const router = useRouter();
  const close = useCallback(() => setOpen(false), []);
  const reverse = mode === "reverse";
  const action = useCallback(
    (prev: ActionState, formData: FormData) => settleAction(reverse ? reverseSaleAction : reactivateSaleAction, prev, formData, SALE_STATUS_UNCERTAIN),
    [reverse],
  );
  const refresh = useCallback(() => {
    setOpen(false);
    startRefresh(() => router.refresh());
  }, [router]);
  const renderAlert = useCallback(
    (state: ActionState) =>
      saleStatusAlert(state) &&
      state.status === "error" && (
        <div role="alert" className="space-y-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          <p>{state.message}</p>
          <Button size="sm" variant="secondary" onClick={refresh}>
            <RefreshCw className="size-4" aria-hidden />
            Atualizar venda
          </Button>
        </div>
      ),
    [refresh],
  );
  return (
    <>
      <Button variant={reverse ? "danger" : "secondary"} size="sm" disabled={refreshing} onClick={() => setOpen(true)}>
        {reverse ? <Undo2 className="size-4" aria-hidden /> : <Redo2 className="size-4" aria-hidden />}
        {refreshing ? "Atualizando…" : reverse ? "Estornar venda" : "Reativar venda"}
      </Button>
      <ActionModal
        open={open}
        onClose={close}
        title={reverse ? "Estornar venda" : "Reativar venda"}
        description={
          reverse
            ? "A venda continua registrada (itens e histórico), mas deixa de contar em faturamento, comissão e ranking. Se for a última venda válida do lead, ele volta para Lead cadastrado em um novo ciclo."
            : "A venda volta a ser válida e o lead vai para Fechamento com o vendedor responsável da venda."
        }
        action={action}
        submitLabel={reverse ? "Confirmar estorno" : "Confirmar reativação"}
        submitVariant={reverse ? "danger" : "primary"}
        renderAlert={renderAlert}
      >
        {(errors) => (
          <>
            <input type="hidden" name="saleId" value={saleId} />
            <input type="hidden" name="expectedVersion" value={version} />
            <Field label="Motivo" htmlFor={`${mode}-reason-${saleId}`} errors={errors.reason} hint="Obrigatório. Fica no histórico da venda.">
              <Textarea
                id={`${mode}-reason-${saleId}`}
                name="reason"
                required
                maxLength={2000}
                aria-invalid={errors.reason?.length ? true : undefined}
              />
            </Field>
          </>
        )}
      </ActionModal>
    </>
  );
}
