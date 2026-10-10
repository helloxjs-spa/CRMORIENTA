import type { Metadata } from "next";
import { Hourglass, Inbox, Trash2, Users, UserX } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/cn";
import { courseLabel } from "@/lib/leads";
import { hasPermission } from "@/server/authz/permissions";
import { listCourseFilterOptions } from "@/server/modules/courses/courses.service";
import { countDecisionQueue, listLeadSellers } from "@/server/modules/leads/leads.service";
import { listTeams } from "@/server/modules/teams/teams.service";
import { requireServiceContext } from "@/server/next/session";
import { LeadActionsProvider } from "./lead-actions";
import { LeadDetail, LeadDetailSkeleton } from "./lead-detail";
import { NewLeadDialog } from "./lead-dialogs";
import { LeadsResults, LeadsResultsSkeleton, type Viewer } from "./leads-results";
import { LeadsToolbar, type ToolbarOptions } from "./leads-toolbar";
import { leadsHref, parseLeadsParams, type LeadsParams, type QueueFilter } from "./search-params";

export const metadata: Metadata = { title: "Leads" };

/**
 * Tela operacional de Leads. Filtros, página, aba e lead aberto ficam na URL;
 * cada leitura passa pelos serviços (RBAC + escopo + paginação no banco).
 */
export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const ctx = await requireServiceContext();
  const { actor } = ctx;
  const canManage = hasPermission(actor, "leads:transfer");
  const isAdmin = actor.role === "ADMIN";
  const canCreate = hasPermission(actor, "leads:create");

  const raw = parseLeadsParams(await searchParams);
  // Quem não opera a equipe (SELLER) fica sempre na própria carteira.
  const params: LeadsParams = canManage ? raw : { ...raw, view: "carteira", seller: undefined, team: undefined };
  const viewer: Viewer = { actor, canManage, isAdmin };

  const [courses, sellers, teams, queue] = await Promise.all([
    listCourseFilterOptions(ctx),
    canManage ? listLeadSellers(ctx) : Promise.resolve([]),
    isAdmin ? listTeams(ctx) : Promise.resolve([]),
    canManage ? countDecisionQueue(ctx) : Promise.resolve(null),
  ]);

  const toolbarOptions: ToolbarOptions = {
    stages: true,
    courses: courses.map((c) => ({ id: c.id, label: `${courseLabel(c)}${c.active ? "" : " (inativo)"}` })),
    sellers: canManage
      ? sellers.map((s) => ({ id: s.id, label: `${s.name}${isAdmin && s.teamName ? ` — ${s.teamName}` : ""}${s.active ? "" : " (inativo)"}` }))
      : undefined,
    teams: isAdmin ? teams.map((t) => ({ id: t.id, label: `${t.name}${t.active ? "" : " (inativa)"}` })) : undefined,
  };
  const queueTotal = queue ? queue.unassigned + queue.followUp3Expired : 0;

  return (
    <LeadActionsProvider sellers={sellers} groupByTeam={isAdmin}>
      <PageHeader
        title="Leads"
        description="Gerencie sua carteira e acompanhe o andamento dos contatos."
        actions={canCreate && actor.teamId ? <NewLeadDialog courses={courses.filter((c) => c.active)} /> : undefined}
      />

      {canCreate && !actor.teamId && (
        <Card className="mb-4 px-4 py-3 text-sm text-amber-800 ring-amber-200">
          Você não está vinculado a uma equipe, por isso ainda não pode cadastrar leads. Procure o administrador.
        </Card>
      )}

      {canManage && (
        <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200" aria-label="Visões de leads">
          <Tab href={leadsHref(params, { view: "carteira", queue: "todos", page: 1, lead: undefined })} active={params.view === "carteira"} icon={Users}>
            Leads
          </Tab>
          <Tab href={leadsHref(params, { view: "fila", page: 1, lead: undefined, stage: undefined })} active={params.view === "fila"} icon={Inbox}>
            Fila de decisão
            {queueTotal > 0 && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">{queueTotal}</span>}
          </Tab>
          <Tab href={leadsHref(params, { view: "lixeira", queue: "todos", page: 1, lead: undefined, stage: undefined })} active={params.view === "lixeira"} icon={Trash2}>
            Lixeira
          </Tab>
        </nav>
      )}

      {params.view === "fila" && queue && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <QueueCard params={params} filter="todos" label="Todos" count={queueTotal} icon={Inbox} hint="Tudo que aguarda decisão" />
          <QueueCard
            params={params}
            filter="follow-up-3"
            label="Follow-up 3 vencido"
            count={queue.followUp3Expired}
            icon={Hourglass}
            hint="Redistribuir ou enviar para a Lixeira"
          />
          <QueueCard
            params={params}
            filter="sem-responsavel"
            label="Sem responsável"
            count={queue.unassigned}
            icon={UserX}
            hint="Vendedor desativado: transferir ou Lixeira"
          />
        </div>
      )}

      <LeadsToolbar params={params} options={toolbarOptions} />

      <Suspense key={leadsHref(params, { lead: undefined })} fallback={<LeadsResultsSkeleton />}>
        <LeadsResults ctx={ctx} params={params} viewer={viewer} />
      </Suspense>

      {params.lead && (
        <Drawer closeHref={leadsHref(params, { lead: undefined })} label="Detalhes do lead">
          <Suspense key={params.lead} fallback={<LeadDetailSkeleton />}>
            <LeadDetail ctx={ctx} id={params.lead} courses={courses} />
          </Suspense>
        </Drawer>
      )}
    </LeadActionsProvider>
  );
}

function Tab({ href, active, icon: Icon, children }: { href: string; active: boolean; icon: typeof Users; children: ReactNode }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
        active ? "border-brand-800 text-brand-800" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800",
      )}
    >
      <Icon className="size-4" aria-hidden />
      {children}
    </Link>
  );
}

function QueueCard({
  params,
  filter,
  label,
  count,
  icon: Icon,
  hint,
}: {
  params: LeadsParams;
  filter: QueueFilter;
  label: string;
  count: number;
  icon: typeof Users;
  hint: string;
}) {
  const active = params.queue === filter;
  return (
    <Link
      href={leadsHref(params, { queue: filter, page: 1, lead: undefined })}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 transition-colors",
        active ? "ring-2 ring-brand-600" : "ring-slate-200 hover:ring-slate-300",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-800">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-600">{label}</span>
        <span className="block text-2xl font-semibold tracking-tight text-slate-900">{count}</span>
        <span className="block truncate text-xs text-slate-500">{hint}</span>
      </span>
    </Link>
  );
}
