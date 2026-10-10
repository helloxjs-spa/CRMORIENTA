"use client";

import { ArrowRight, Loader2 } from "lucide-react";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
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

/** Botões "Mover para" do drawer: só os destinos permitidos agora. */
export function MoveStageButtons({ leadId, targets }: { leadId: string; targets: LeadStage[] }) {
  const move = useMoveLead();
  const [pending, startTransition] = useTransition();
  if (targets.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-slate-500">Mover para:</span>
      {targets.map((stage) => (
        <Button key={stage} size="sm" variant="secondary" disabled={pending} onClick={() => startTransition(async () => void (await move(leadId, stage)))}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowRight className="size-3.5" aria-hidden />}
          {STAGE_LABELS[stage]}
        </Button>
      ))}
    </div>
  );
}
