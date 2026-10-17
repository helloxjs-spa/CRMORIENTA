import { CheckCircle2 } from "lucide-react";
import { ActionButton } from "@/components/ui/action-button";
import { Badge } from "@/components/ui/badge";
import { INSTALLMENT_STATUS_LABELS } from "@/lib/installments";
import { formatSaleDate } from "@/lib/sales";
import type { InstallmentStatus } from "@/server/db/schema";
import { markInstallmentPaidAction } from "./actions";

/** Situação da parcela; "Vencida" = em aberto com vencimento antes de hoje (só exibição). */
export function InstallmentStatusBadge({ status, dueDate, today }: { status: InstallmentStatus; dueDate: string; today: string }) {
  if (status === "OPEN" && dueDate < today) return <Badge tone="warning">Vencida</Badge>;
  const tone = status === "PAID" ? "success" : status === "CANCELED" ? "neutral" : "brand";
  return <Badge tone={tone}>{INSTALLMENT_STATUS_LABELS[status]}</Badge>;
}

/** "Marcar como paga" (só parcela em aberto), com confirmação; o servidor revalida tudo. */
export function MarkPaidButton({ installmentId, number, amount, dueDate }: { installmentId: string; number: number; amount: string; dueDate: string }) {
  return (
    <ActionButton
      action={markInstallmentPaidAction}
      fields={{ installmentId }}
      confirm={`Marcar a parcela ${number} (${amount}, vencimento ${formatSaleDate(dueDate)}) como paga? O pagamento fica registrado com a data de hoje e não pode ser desfeito.`}
    >
      <CheckCircle2 className="size-4" aria-hidden />
      Marcar como paga
    </ActionButton>
  );
}
