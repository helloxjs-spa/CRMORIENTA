import { AlertTriangle, Clock, Hourglass, UserX } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { formatRelativeDateTime } from "@/lib/format";
import { deadlineInfo, QUEUE_REASON_LABELS, STAGE_LABELS, type LeadQueueReason } from "@/lib/leads";
import type { LeadStage, LeadStatus } from "@/server/db/schema";

const STAGE_TONES: Record<LeadStage, BadgeTone> = {
  NEW: "neutral",
  NO_ANSWER: "neutral",
  FOLLOW_UP_1: "brand",
  FOLLOW_UP_2: "brand",
  FOLLOW_UP_3: "brand",
  NEGOTIATION: "warning",
  CLOSED: "success",
  REWORK: "brand",
};

export function StageBadge({ stage }: { stage: LeadStage }) {
  return <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>;
}

export function QueueReasonBadge({ reason }: { reason: LeadQueueReason }) {
  return (
    <Badge tone={reason === "UNASSIGNED" ? "warning" : "brand"} className="gap-1">
      {reason === "UNASSIGNED" ? <UserX className="size-3" aria-hidden /> : <Hourglass className="size-3" aria-hidden />}
      {QUEUE_REASON_LABELS[reason]}
    </Badge>
  );
}

type DeadlineLead = { status: LeadStatus; ownerId: string | null; stage: LeadStage; stageDueAt: Date | null };

/** Situação do prazo da etapa (calculada a cada leitura a partir de stage_due_at). */
export function DeadlineBadge({ lead, now, withDetail = true }: { lead: DeadlineLead; now: Date; withDetail?: boolean }) {
  const info = deadlineInfo(lead, now);
  switch (info.kind) {
    case "none":
      return <span className="text-xs text-slate-400">Sem prazo</span>;
    case "unassigned":
      return (
        <Badge tone="warning" className="gap-1">
          <UserX className="size-3" aria-hidden />
          Sem responsável
        </Badge>
      );
    case "awaiting_supervisor":
      return (
        <Badge tone="brand" className="gap-1">
          <Hourglass className="size-3" aria-hidden />
          Aguardando supervisor
        </Badge>
      );
    case "overdue":
      return (
        <span className="inline-flex flex-col items-start gap-0.5">
          <Badge tone="danger" className="gap-1">
            <AlertTriangle className="size-3" aria-hidden />
            Vencido
          </Badge>
          {withDetail && <span className="text-[11px] text-slate-500">desde {formatRelativeDateTime(info.dueAt, now)}</span>}
        </span>
      );
    case "due_today":
      return (
        <Badge tone="warning" className="gap-1">
          <Clock className="size-3" aria-hidden />
          Vence {formatRelativeDateTime(info.dueAt, now)}
        </Badge>
      );
    case "on_time":
      return (
        <span className="inline-flex flex-col items-start gap-0.5">
          <Badge tone="success">No prazo</Badge>
          {withDetail && <span className="text-[11px] text-slate-500">vence {formatRelativeDateTime(info.dueAt, now)}</span>}
        </span>
      );
  }
}
