import { PencilLine, Redo2, ShoppingCart, Undo2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatRelativeDateTime } from "@/lib/format";
import { describeSaleEvent } from "@/lib/sale-history";
import type { SaleEventType } from "@/server/db/schema";
import type { SaleHistoryView } from "@/server/modules/sales/sales.service";

const ICONS: Record<SaleEventType, { icon: LucideIcon; className: string }> = {
  CREATED: { icon: ShoppingCart, className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  UPDATED: { icon: PencilLine, className: "bg-slate-100 text-slate-600 ring-slate-200" },
  REVERSED: { icon: Undo2, className: "bg-red-50 text-red-600 ring-red-200" },
  REACTIVATED: { icon: Redo2, className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
};

/** Histórico da venda (sale_events), mais recente primeiro. */
export function SaleHistory({ history, now }: { history: SaleHistoryView; now: Date }) {
  if (history.entries.length === 0) return <p className="text-sm text-slate-500">Nenhum evento registrado.</p>;
  return (
    <ol className="relative space-y-4 before:absolute before:inset-y-1 before:left-[15px] before:w-px before:bg-slate-200">
      {[...history.entries].reverse().map((event) => {
        const text = describeSaleEvent(event, history.names);
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
              {text.lines.map((line, i) => (
                <p key={i} className="mt-0.5 text-sm text-slate-600">
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
  );
}
