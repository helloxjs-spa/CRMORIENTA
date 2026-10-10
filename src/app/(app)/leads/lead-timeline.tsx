import {
  ArchiveRestore,
  ArrowRightLeft,
  CircleDot,
  MessageSquareText,
  PencilLine,
  RotateCcw,
  Trash2,
  UserPlus,
  UserX,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { formatRelativeDateTime } from "@/lib/format";
import { describeLeadEvent } from "@/lib/lead-timeline";
import type { LeadEventType } from "@/server/db/schema";
import type { LeadTimelineEntry } from "@/server/modules/leads/leads.service";

const ICONS: Record<LeadEventType, { icon: LucideIcon; className: string }> = {
  CREATED: { icon: UserPlus, className: "bg-brand-50 text-brand-700 ring-brand-200" },
  DETAILS_UPDATED: { icon: PencilLine, className: "bg-slate-100 text-slate-600 ring-slate-200" },
  STAGE_CHANGED: { icon: CircleDot, className: "bg-brand-50 text-brand-700 ring-brand-200" },
  TRANSFERRED: { icon: ArrowRightLeft, className: "bg-sky-50 text-sky-700 ring-sky-200" },
  TEAM_CHANGED: { icon: Users, className: "bg-sky-50 text-sky-700 ring-sky-200" },
  UNASSIGNED: { icon: UserX, className: "bg-amber-50 text-amber-700 ring-amber-200" },
  REDISTRIBUTED: { icon: RotateCcw, className: "bg-violet-50 text-violet-700 ring-violet-200" },
  TRASHED: { icon: Trash2, className: "bg-red-50 text-red-600 ring-red-200" },
  RESTORED: { icon: ArchiveRestore, className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  NOTE_ADDED: { icon: MessageSquareText, className: "bg-slate-100 text-slate-600 ring-slate-200" },
};

/**
 * Linha do tempo do lead, a partir de lead_events (e lead_notes), agrupada
 * por ciclo de atendimento: o 1º atendimento e cada Retrabalho ficam
 * separados. Mais recente primeiro.
 */
export function LeadTimeline({ events, now }: { events: LeadTimelineEntry[]; now: Date }) {
  if (events.length === 0) return <p className="text-sm text-slate-500">Nenhum evento registrado.</p>;

  const cycles = new Map<number, { kind: LeadTimelineEntry["cycleKind"]; events: LeadTimelineEntry[] }>();
  for (const event of [...events].reverse()) {
    const cycle = cycles.get(event.cycleNumber) ?? { kind: event.cycleKind, events: [] };
    cycle.events.push(event);
    cycles.set(event.cycleNumber, cycle);
  }
  const showCycles = cycles.size > 1;

  return (
    <div className="space-y-5">
      {[...cycles].map(([number, cycle]) => (
        <section key={number} aria-label={`Ciclo ${number}`}>
          {showCycles && (
            <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Ciclo {number} · {cycle.kind === "INITIAL" ? "Atendimento inicial" : "Retrabalho"}
            </h4>
          )}
          <ol className="relative space-y-4 before:absolute before:inset-y-1 before:left-[15px] before:w-px before:bg-slate-200">
            {cycle.events.map((event) => {
              const text = describeLeadEvent(event, now);
              const { icon: Icon, className } = ICONS[event.type];
              return (
                <li key={event.id} className="relative flex gap-3">
                  <span className={cn("z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-1", className)}>
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1 pt-1">
                    <p className="text-sm font-medium text-slate-900">{text.title}</p>
                    {text.quote && (
                      <blockquote className="mt-1 whitespace-pre-line rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200">
                        “{text.quote}”
                      </blockquote>
                    )}
                    {text.lines.map((line) => (
                      <p key={line} className="mt-0.5 text-sm text-slate-600">
                        {line}
                      </p>
                    ))}
                    <p className="mt-1 text-xs text-slate-500">
                      {event.actorName} • <time dateTime={event.occurredAt.toISOString()}>{formatRelativeDateTime(event.occurredAt, now)}</time>
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
