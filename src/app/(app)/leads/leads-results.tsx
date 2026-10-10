import { ChevronLeft, ChevronRight, Contact, SearchX } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatRelativeDateTime, formatShortDate } from "@/lib/format";
import { LEAD_PAGE_SIZES } from "@/lib/leads";
import { formatPhone } from "@/lib/phone";
import type { Actor } from "@/server/authz/actor";
import type { ServiceContext } from "@/server/context";
import { listLeads, type LeadView } from "@/server/modules/leads/leads.service";
import { ClickableRow } from "./clickable-row";
import { DeadlineBadge, QueueReasonBadge, StageBadge } from "./lead-badges";
import { LeadAdminActions, type LeadActionTarget } from "./lead-actions";
import { leadActionsFor } from "./policy";
import { hasResultFilters, leadsHref, toListFilters, type LeadsParams } from "./search-params";

export type Viewer = { actor: Actor; canManage: boolean; isAdmin: boolean };

/** Só o que o menu de ações precisa (o resto do lead não vai para o cliente). */
export function actionTarget(l: LeadView): LeadActionTarget {
  return { id: l.id, name: l.name, ownerId: l.ownerId, ownerName: l.ownerName, teamName: l.teamName, stage: l.stage };
}

type Column = { key: string; header: string; className?: string; cell: (lead: LeadView) => ReactNode };

function columnsFor(view: LeadsParams["view"], viewer: Viewer, now: Date): Column[] {
  const lead: Column = {
    key: "lead",
    header: "Lead",
    cell: (l) => <span className="font-medium text-slate-900">{l.name}</span>,
  };
  const phone: Column = { key: "phone", header: "Telefone", className: "tabular-nums", cell: (l) => formatPhone(l.phone) };
  const course: Column = {
    key: "course",
    header: "Curso",
    cell: (l) => (
      <span className="block max-w-56 truncate" title={`${l.interestCourseName} — ${l.interestCourseInstitution}`}>
        {l.interestCourseName}
        <span className="block truncate text-xs text-slate-500">{l.interestCourseInstitution}</span>
      </span>
    ),
  };
  const stage: Column = { key: "stage", header: "Etapa", cell: (l) => <StageBadge stage={l.stage} /> };
  const owner: Column = {
    key: "owner",
    header: view === "lixeira" ? "Último responsável" : "Responsável",
    cell: (l) => l.ownerName ?? <span className="text-slate-400">Sem responsável</span>,
  };
  const team: Column = { key: "team", header: "Equipe", cell: (l) => l.teamName };
  const deadline: Column = { key: "deadline", header: "Prazo", cell: (l) => <DeadlineBadge lead={l} now={now} /> };
  const created: Column = {
    key: "created",
    header: "Cadastro",
    className: "tabular-nums text-slate-500",
    cell: (l) => formatShortDate(l.createdAt),
  };

  if (view === "lixeira") {
    return [
      lead,
      phone,
      course,
      owner,
      team,
      { key: "trashedAt", header: "Enviado em", className: "tabular-nums text-slate-500", cell: (l) => (l.trashedAt ? formatRelativeDateTime(l.trashedAt, now) : "—") },
      { key: "trashedBy", header: "Enviado por", cell: (l) => l.trashedByName ?? "—" },
    ];
  }
  if (view === "fila") {
    return [
      lead,
      phone,
      course,
      stage,
      { key: "reason", header: "Motivo", cell: (l) => (l.queueReason ? <QueueReasonBadge reason={l.queueReason} /> : null) },
      owner,
      ...(viewer.isAdmin ? [team] : []),
      {
        key: "since",
        header: "Desde",
        className: "tabular-nums text-slate-500",
        cell: (l) => {
          const since = l.queueReason === "UNASSIGNED" ? l.unassignedAt : l.stageDueAt;
          return since ? formatRelativeDateTime(since, now) : "—";
        },
      },
    ];
  }
  return [lead, phone, course, stage, ...(viewer.canManage ? [owner] : []), ...(viewer.isAdmin ? [team] : []), deadline, created];
}

/** Resultado paginado (consulta no banco já com escopo, filtros, LIMIT/OFFSET). */
export async function LeadsResults({ ctx, params, viewer }: { ctx: ServiceContext; params: LeadsParams; viewer: Viewer }) {
  const result = await listLeads(ctx, toListFilters(params, { canManage: viewer.canManage, canFilterTeam: viewer.isAdmin }));
  const now = new Date();
  const columns = columnsFor(params.view, viewer, now);
  const rowHref = (l: LeadView) => leadsHref(params, { lead: l.id });

  if (result.total === 0) {
    const filtered = hasResultFilters(params);
    const empty =
      params.view === "fila"
        ? { title: "Nenhum lead aguardando decisão", description: "Leads sem responsável ou com Follow-up 3 vencido aparecem aqui." }
        : params.view === "lixeira"
          ? { title: "A Lixeira está vazia", description: "Leads enviados para a Lixeira aparecem aqui e podem ser recuperados." }
          : viewer.actor.role === "SELLER"
            ? { title: "Sua carteira está vazia", description: "Cadastre o primeiro lead com o botão Novo Lead." }
            : { title: "Nenhum lead em operação", description: "Os leads cadastrados pelos vendedores aparecem aqui." };
    return (
      <Card>
        <EmptyState
          icon={filtered ? SearchX : Contact}
          title={filtered ? "Nenhum resultado para os filtros" : empty.title}
          description={filtered ? "Ajuste a busca ou limpe os filtros para ver outros leads." : empty.description}
        />
      </Card>
    );
  }

  return (
    <>
      {/* Desktop: tabela */}
      <Card className="hidden md:block">
        <Table>
          <thead>
            <tr>
              {columns.map((c) => (
                <Th key={c.key}>{c.header}</Th>
              ))}
              {viewer.canManage && (
                <Th>
                  <span className="sr-only">Ações</span>
                </Th>
              )}
            </tr>
          </thead>
          <Tbody>
            {result.items.map((l) => (
              <ClickableRow key={l.id} href={rowHref(l)}>
                {columns.map((c) => (
                  <Td key={c.key} className={c.className}>
                    {c.key === "lead" ? (
                      <Link href={rowHref(l)} scroll={false} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">
                        {l.name}
                      </Link>
                    ) : (
                      c.cell(l)
                    )}
                  </Td>
                ))}
                {viewer.canManage && (
                  <Td className="text-right">
                    <LeadAdminActions lead={actionTarget(l)} actions={leadActionsFor(l, viewer.actor)} />
                  </Td>
                )}
              </ClickableRow>
            ))}
          </Tbody>
        </Table>
      </Card>

      {/* Celular: cards */}
      <ul className="space-y-2 md:hidden">
        {result.items.map((l) => (
          <li key={l.id} className="relative rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <div className="flex items-start justify-between gap-2">
              <Link href={rowHref(l)} scroll={false} className="min-w-0 after:absolute after:inset-0">
                <p className="truncate font-medium text-slate-900">{l.name}</p>
                <p className="text-sm tabular-nums text-slate-500">{formatPhone(l.phone)}</p>
              </Link>
              {viewer.canManage && (
                <div className="relative z-10">
                  <LeadAdminActions lead={actionTarget(l)} actions={leadActionsFor(l, viewer.actor)} />
                </div>
              )}
            </div>
            <p className="mt-1 truncate text-sm text-slate-600">
              {l.interestCourseName} — {l.interestCourseInstitution}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {params.view !== "lixeira" && <StageBadge stage={l.stage} />}
              {params.view === "fila" && l.queueReason ? (
                <QueueReasonBadge reason={l.queueReason} />
              ) : params.view === "carteira" ? (
                <DeadlineBadge lead={l} now={now} withDetail={false} />
              ) : null}
            </div>
            {(viewer.canManage || params.view === "lixeira") && (
              <p className="mt-2 text-xs text-slate-500">
                {l.ownerName ?? "Sem responsável"}
                {viewer.isAdmin ? ` · ${l.teamName}` : ""}
                {params.view === "lixeira" && l.trashedAt ? ` · na Lixeira desde ${formatRelativeDateTime(l.trashedAt, now)}` : ""}
              </p>
            )}
          </li>
        ))}
      </ul>

      <Pagination params={params} page={result.page} pageSize={result.pageSize} total={result.total} totalPages={result.totalPages} />
    </>
  );
}

function pageWindow(page: number, totalPages: number): (number | "…")[] {
  const pages = new Set([1, totalPages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= totalPages));
  const sorted = [...pages].sort((a, b) => a - b);
  const result: (number | "…")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) result.push("…");
    result.push(p);
  });
  return result;
}

function Pagination({ params, page, pageSize, total, totalPages }: { params: LeadsParams; page: number; pageSize: number; total: number; totalPages: number }) {
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const link = "inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm";

  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600" aria-label="Paginação">
      <p>
        Mostrando <span className="font-medium text-slate-900">{from}</span>–<span className="font-medium text-slate-900">{to}</span> de{" "}
        <span className="font-medium text-slate-900">{total}</span> {total === 1 ? "lead" : "leads"}
      </p>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1" aria-label="Por página">
          <span className="text-xs text-slate-500">Por página:</span>
          {LEAD_PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={leadsHref(params, { size, page: 1, lead: undefined })}
              scroll={false}
              aria-current={size === pageSize ? "true" : undefined}
              className={cn(link, size === pageSize ? "bg-brand-50 font-medium text-brand-800 ring-1 ring-brand-200" : "hover:bg-slate-100")}
            >
              {size}
            </Link>
          ))}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            {page > 1 ? (
              <Link href={leadsHref(params, { page: page - 1, lead: undefined })} scroll={false} className={cn(link, "hover:bg-slate-100")} aria-label="Página anterior">
                <ChevronLeft className="size-4" />
              </Link>
            ) : (
              <span className={cn(link, "text-slate-300")} aria-hidden>
                <ChevronLeft className="size-4" />
              </span>
            )}
            {pageWindow(page, totalPages).map((p, i) =>
              p === "…" ? (
                <span key={`gap-${i}`} className="px-1 text-slate-400">
                  …
                </span>
              ) : (
                <Link
                  key={p}
                  href={leadsHref(params, { page: p, lead: undefined })}
                  scroll={false}
                  aria-current={p === page ? "page" : undefined}
                  className={cn(link, p === page ? "bg-brand-800 font-medium text-white" : "hover:bg-slate-100")}
                >
                  {p}
                </Link>
              ),
            )}
            {page < totalPages ? (
              <Link href={leadsHref(params, { page: page + 1, lead: undefined })} scroll={false} className={cn(link, "hover:bg-slate-100")} aria-label="Próxima página">
                <ChevronRight className="size-4" />
              </Link>
            ) : (
              <span className={cn(link, "text-slate-300")} aria-hidden>
                <ChevronRight className="size-4" />
              </span>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}

export function LeadsResultsSkeleton() {
  return (
    <Card className="p-4" aria-busy="true" aria-label="Carregando leads">
      <div className="space-y-3">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="hidden h-4 w-28 md:block" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="hidden h-5 w-24 rounded-full md:block" />
            <Skeleton className="ml-auto h-5 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </Card>
  );
}
