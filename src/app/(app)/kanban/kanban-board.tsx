"use client";

import { ArrowRight, GripVertical, Loader2, Lock } from "lucide-react";
import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { STAGE_LABELS, type DeadlineInfo } from "@/lib/leads";
import type { LeadStage, LeadStatus } from "@/server/db/schema";
import { DeadlineBadge } from "../leads/lead-badges";
import { LeadAdminActions, type LeadActionTarget } from "../leads/lead-actions";
import type { LeadActionKey } from "../leads/policy";
import { useMoveLead } from "../leads/stage-move";

export type KanbanCard = {
  id: string;
  name: string;
  phone: string;
  course: string;
  ownerName: string | null;
  teamName: string | null;
  stage: LeadStage;
  status: LeadStatus;
  ownerId: string | null;
  stageDueAt: string | null;
  deadline: DeadlineInfo["kind"];
  href: string;
  /** Destinos permitidos agora (calculados no servidor; o backend revalida). */
  targets: LeadStage[];
  adminActions: LeadActionKey[];
  actionTarget: LeadActionTarget;
  pending?: boolean;
};

export type KanbanColumn = { stage: LeadStage; total: number; listHref: string; cards: KanbanCard[] };

type Move = { leadId: string; from: LeadStage; to: LeadStage };

function applyMove(columns: KanbanColumn[], move: Move): KanbanColumn[] {
  const card = columns.find((c) => c.stage === move.from)?.cards.find((c) => c.id === move.leadId);
  if (!card) return columns;
  return columns.map((column) => {
    if (column.stage === move.from) return { ...column, total: column.total - 1, cards: column.cards.filter((c) => c.id !== move.leadId) };
    if (column.stage === move.to) {
      return { ...column, total: column.total + 1, cards: [{ ...card, stage: move.to, targets: [], pending: true }, ...column.cards] };
    }
    return column;
  });
}

/**
 * Quadro Kanban. Arrastar (ou "Mover para") só oferece destinos válidos, mas
 * isso é conveniência: a action chama moveLeadStage, que valida transição,
 * escopo, Follow-up 3 vencido e negociação vencida. Em erro, o card volta.
 */
export function KanbanBoard({ columns, now, canMove }: { columns: KanbanColumn[]; now: string; canMove: boolean }) {
  const move = useMoveLead();
  const [, startTransition] = useTransition();
  const [board, applyOptimistic] = useOptimistic(columns, applyMove);
  const [dragging, setDragging] = useState<KanbanCard | null>(null);
  const [over, setOver] = useState<LeadStage | null>(null);
  const nowDate = new Date(now);

  const doMove = (card: KanbanCard, to: LeadStage) => {
    if (!card.targets.includes(to)) return;
    startTransition(async () => {
      applyOptimistic({ leadId: card.id, from: card.stage, to });
      await move(card.id, to);
    });
  };

  return (
    <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0" aria-label="Quadro Kanban">
      {board.map((column) => {
        const isTarget = !!dragging && dragging.targets.includes(column.stage);
        return (
          <section
            key={column.stage}
            aria-label={STAGE_LABELS[column.stage]}
            onDragOver={(e) => {
              if (!isTarget) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (over !== column.stage) setOver(column.stage);
            }}
            onDragLeave={() => over === column.stage && setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              const card = dragging;
              setDragging(null);
              setOver(null);
              if (card && isTarget) doMove(card, column.stage);
            }}
            className={cn(
              "flex w-72 shrink-0 snap-start flex-col rounded-xl bg-slate-100/80 ring-1 ring-slate-200 transition",
              dragging && !isTarget && dragging.stage !== column.stage && "opacity-45",
              isTarget && "bg-brand-50 outline-2 outline-dashed outline-brand-400",
              over === column.stage && "outline-brand-700 bg-brand-100/70",
            )}
          >
            <header className="flex items-center justify-between gap-2 px-3 py-2.5">
              <h2 className="text-sm font-semibold text-slate-800">{STAGE_LABELS[column.stage]}</h2>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200">{column.total}</span>
            </header>
            <ol className="flex max-h-[calc(100vh-17rem)] min-h-24 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {column.cards.map((card) => (
                <Card
                  key={card.id}
                  card={card}
                  now={nowDate}
                  canMove={canMove}
                  onDragStart={() => setDragging(card)}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onMove={(to) => doMove(card, to)}
                />
              ))}
              {column.cards.length === 0 && (
                <li className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
                  {isTarget ? "Solte aqui" : "Nenhum lead"}
                </li>
              )}
            </ol>
            {column.total > column.cards.length && (
              <Link href={column.listHref} className="border-t border-slate-200 px-3 py-2 text-center text-xs font-medium text-brand-700 hover:underline">
                Mostrando {column.cards.length} de {column.total} — ver todos na lista
              </Link>
            )}
          </section>
        );
      })}

      {/* Fechamento: depende da criação da venda (fase Vendas). Nunca aceita card. */}
      <section aria-label="Fechamento" className="flex w-72 shrink-0 snap-start flex-col rounded-xl bg-slate-50 ring-1 ring-slate-200">
        <header className="flex items-center justify-between gap-2 px-3 py-2.5">
          <h2 className="text-sm font-semibold text-slate-400">{STAGE_LABELS.CLOSED}</h2>
          <Lock className="size-4 text-slate-400" aria-hidden />
        </header>
        <p className="mx-2 mb-2 rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-500">
          Indisponível até a fase de Vendas: o fechamento acontece ao registrar uma venda, não arrastando o card.
        </p>
      </section>
    </div>
  );
}

function Card({
  card,
  now,
  canMove,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  card: KanbanCard;
  now: Date;
  canMove: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (to: LeadStage) => void;
}) {
  const draggable = canMove && card.targets.length > 0 && !card.pending;
  const awaiting = card.deadline === "awaiting_supervisor";
  const lead = { status: card.status, ownerId: card.ownerId, stage: card.stage, stageDueAt: card.stageDueAt ? new Date(card.stageDueAt) : null };

  return (
    <li
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative rounded-lg bg-white p-3 shadow-sm ring-1 ring-slate-200 transition",
        draggable && "cursor-grab active:cursor-grabbing hover:ring-brand-300",
        awaiting && "ring-2 ring-brand-200",
        card.pending && "opacity-70",
      )}
    >
      <div className="flex items-start gap-1.5">
        {draggable ? (
          <GripVertical className="mt-0.5 size-4 shrink-0 text-slate-300 group-hover:text-slate-400" aria-hidden />
        ) : (
          canMove && <Lock className="mt-0.5 size-3.5 shrink-0 text-slate-300" aria-label="Somente leitura" />
        )}
        <Link href={card.href} scroll={false} className="min-w-0 flex-1" draggable={false}>
          <p className="truncate text-sm font-medium text-slate-900 hover:text-brand-700">{card.name}</p>
          <p className="text-xs tabular-nums text-slate-500">{card.phone}</p>
        </Link>
        {card.pending ? (
          <Loader2 className="size-4 animate-spin text-slate-400" aria-label="Salvando" />
        ) : card.targets.length > 0 ? (
          <DropdownMenu
            label={`Mover ${card.name}`}
            items={card.targets.map((to) => ({ label: `Mover para ${STAGE_LABELS[to]}`, icon: ArrowRight, onSelect: () => onMove(to) }))}
          />
        ) : (
          <LeadAdminActions lead={card.actionTarget} actions={card.adminActions} />
        )}
      </div>
      <p className="mt-1.5 truncate text-xs text-slate-600" title={card.course}>
        {card.course}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <DeadlineBadge lead={lead} now={now} withDetail={false} />
      </div>
      {(card.ownerName || card.teamName) && (
        <p className="mt-2 truncate text-[11px] text-slate-500">
          {card.ownerName}
          {card.teamName ? ` · ${card.teamName}` : ""}
        </p>
      )}
    </li>
  );
}
