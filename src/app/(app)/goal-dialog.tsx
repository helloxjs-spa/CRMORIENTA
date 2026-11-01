"use client";

import { Pencil, Target } from "lucide-react";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Input } from "@/components/ui/form";
import { centsToInput } from "@/lib/money";
import { setSalesGoalAction } from "./goal-actions";

/** Definir/alterar/retirar a meta do mês (geral quando sellerId é null). O serviço revalida permissão e escopo. */
export function GoalDialog({
  month,
  monthLabel,
  sellerId,
  sellerName,
  goalCents,
}: {
  month: string;
  monthLabel: string;
  sellerId: string | null;
  sellerName?: string;
  goalCents: number | null;
}) {
  const inputId = `goal-${sellerId ?? "general"}-${month}`;
  return (
    <ActionDialog
      trigger={{ label: goalCents ? "Editar meta" : "Definir meta", icon: goalCents ? Pencil : Target, variant: "ghost", size: "sm" }}
      title={`Meta de ${monthLabel}`}
      description={`Meta de faturamento ${sellerId ? `de ${sellerName}` : "do time inteiro"}. Deixe em branco para retirar a meta.`}
      action={setSalesGoalAction}
      submitLabel="Salvar meta"
    >
      {(errors) => (
        <>
          <input type="hidden" name="month" value={month} />
          <input type="hidden" name="sellerId" value={sellerId ?? ""} />
          <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
            Valor (R$)
          </label>
          <Input
            id={inputId}
            name="amount"
            inputMode="decimal"
            placeholder="0,00"
            autoComplete="off"
            defaultValue={goalCents ? centsToInput(goalCents) : ""}
            aria-invalid={errors.amountCents?.length ? true : undefined}
          />
          {errors.amountCents?.map((error) => (
            <p key={error} className="text-xs font-medium text-red-600">
              {error}
            </p>
          ))}
        </>
      )}
    </ActionDialog>
  );
}
