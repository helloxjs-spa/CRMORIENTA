"use client";

import { ArrowRight, ChevronDown, Loader2 } from "lucide-react";
import { useTransition } from "react";
import { buttonClasses } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { IDLE } from "@/lib/action-state";
import { STAGE_LABELS } from "@/lib/leads";
import type { LeadStage } from "@/server/db/schema";
import { moveLeadStageAction } from "./actions";

/** Chama a action de movimentação (o backend valida tudo de novo) e informa o resultado. */
export function useMoveLead() {
  const toast = useToast();
  return async (leadId: string, toStage: LeadStage): Promise<boolean> => {
    const data = new FormData();
    data.append("leadId", leadId);
    data.append("toStage", toStage);
    const result = await moveLeadStageAction(IDLE, data);
    if (result.status === "error") {
      toast(result.message, "error");
      return false;
    }
    if (result.status === "success") toast(result.message);
    return true;
  };
}

/** Botão "Mover" do drawer: abre a lista com os destinos permitidos agora. */
export function MoveStageButtons({ leadId, targets }: { leadId: string; targets: LeadStage[] }) {
  const move = useMoveLead();
  const [pending, startTransition] = useTransition();
  if (targets.length === 0) return null;

  return (
    <DropdownMenu
      label="Mover para"
      trigger={
        <>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowRight className="size-3.5" aria-hidden />}
          Mover
          <ChevronDown className="size-3.5" aria-hidden />
        </>
      }
      triggerClassName={buttonClasses({ variant: "secondary", size: "sm" })}
      items={targets.map((stage) => ({
        label: STAGE_LABELS[stage],
        icon: ArrowRight,
        onSelect: () => !pending && startTransition(async () => void (await move(leadId, stage))),
      }))}
    />
  );
}
