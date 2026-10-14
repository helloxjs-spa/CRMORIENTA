import type { Metadata } from "next";
import { Suspense } from "react";
import { Drawer } from "@/components/ui/drawer";
import { PageHeader } from "@/components/ui/page-header";
import { courseLabel, deadlineInfo } from "@/lib/leads";
import { formatPhone } from "@/lib/phone";
import { hasPermission } from "@/server/authz/permissions";
import type { LeadStage } from "@/server/db/schema";
import { listCourseFilterOptions } from "@/server/modules/courses/courses.service";
import { getNegotiationBlock, listLeads, listLeadSellers } from "@/server/modules/leads/leads.service";
import { listTeams } from "@/server/modules/teams/teams.service";
import { requireServiceContext } from "@/server/next/session";
import { LeadActionsProvider } from "../leads/lead-actions";
import { LeadDetail, LeadDetailSkeleton } from "../leads/lead-detail";
import { actionTarget } from "../leads/leads-results";
import { LeadsToolbar, type ToolbarOptions } from "../leads/leads-toolbar";
import { NegotiationBanner } from "../leads/negotiation-banner";
import { leadActionsFor, moveTargetsFor } from "../leads/policy";
import { leadsHref, parseLeadsParams, type LeadsParams } from "../leads/search-params";
import { KanbanBoard, type KanbanCard, type KanbanColumn } from "./kanban-board";

export const metadata: Metadata = { title: "Kanban" };

/**
 * Colunas do quadro (Lixeira é visão separada). Fechamento só recebe leads
 * pelo registro de venda: nenhuma transição de etapa leva a ele.
 */
const BOARD_STAGES: LeadStage[] = ["NEW", "NO_ANSWER", "FOLLOW_UP_1", "FOLLOW_UP_2", "FOLLOW_UP_3", "NEGOTIATION", "REWORK", "CLOSED"];
/** Cards por coluna; o total aparece no cabeçalho e o restante fica na lista. */
const CARDS_PER_COLUMN = 50;

export default async function KanbanPage({ searchParams }: PageProps<"/kanban">) {
  const ctx = await requireServiceContext();
  const { actor } = ctx;
  const canManage = hasPermission(actor, "leads:transfer");
  const isAdmin = actor.role === "ADMIN";
  const canSell = hasPermission(actor, "sales:create");

  const raw = parseLeadsParams(await searchParams);
  const params: LeadsParams = { ...raw, view: "carteira", stage: undefined, page: 1, ...(canManage ? {} : { seller: undefined, team: undefined }) };

  const [courses, sellers, teams, block, ...pages] = await Promise.all([
    listCourseFilterOptions(ctx),
    canManage ? listLeadSellers(ctx) : Promise.resolve([]),
    isAdmin ? listTeams(ctx) : Promise.resolve([]),
    getNegotiationBlock(ctx),
    ...BOARD_STAGES.map((stage) =>
      listLeads(ctx, {
        status: "ACTIVE",
        stage,
        search: params.q,
        courseId: params.course,
        ownerId: canManage ? params.seller : undefined,
        teamId: isAdmin ? params.team : undefined,
        pageSize: CARDS_PER_COLUMN,
        order: "deadline",
      }),
    ),
  ]);
  const situation = { negotiationBlocked: (block?.count ?? 0) > 0 };
  const now = new Date();

  const columns: KanbanColumn[] = BOARD_STAGES.map((stage, i) => ({
    stage,
    total: pages[i].total,
    listHref: leadsHref(params, { stage, lead: undefined }),
    cards: pages[i].items.map(
      (lead): KanbanCard => ({
        id: lead.id,
        name: lead.name,
        phone: formatPhone(lead.phone),
        course: courseLabel({ name: lead.interestCourseName, institutionName: lead.interestCourseInstitution }),
        ownerName: canManage ? (lead.ownerName ?? "Sem responsável") : null,
        teamName: isAdmin ? lead.teamName : null,
        stage: lead.stage,
        status: lead.status,
        ownerId: lead.ownerId,
        stageDueAt: lead.stageDueAt?.toISOString() ?? null,
        deadline: deadlineInfo(lead, now).kind,
        href: leadsHref(params, { lead: lead.id }, "/kanban"),
        targets: moveTargetsFor(lead, actor, situation, now),
        adminActions: leadActionsFor(lead, actor, situation),
        actionTarget: actionTarget(lead),
        saleHref: canSell ? `/vendas/nova?lead=${lead.id}` : null,
      }),
    ),
  }));

  const toolbarOptions: ToolbarOptions = {
    stages: false,
    courses: courses.map((c) => ({ id: c.id, label: `${courseLabel(c)}${c.active ? "" : " (inativo)"}` })),
    sellers: canManage
      ? sellers.map((s) => ({ id: s.id, label: `${s.name}${isAdmin && s.teamName ? ` — ${s.teamName}` : ""}${s.active ? "" : " (inativo)"}` }))
      : undefined,
    teams: isAdmin ? teams.map((t) => ({ id: t.id, label: `${t.name}${t.active ? "" : " (inativa)"}` })) : undefined,
  };

  return (
    <LeadActionsProvider sellers={sellers} groupByTeam={isAdmin}>
      <PageHeader
        title="Kanban"
        description={
          hasPermission(actor, "leads:move")
            ? "Arraste o card para a próxima etapa. Só os destinos permitidos aceitam o card."
            : "Acompanhe o funil da equipe. A movimentação de etapas é feita pelo vendedor responsável."
        }
      />
      <NegotiationBanner block={block} openHref={(id) => leadsHref(params, { lead: id }, "/kanban")} />
      <LeadsToolbar params={params} options={toolbarOptions} basePath="/kanban" />

      <KanbanBoard columns={columns} now={now.toISOString()} canMove={hasPermission(actor, "leads:move")} />

      {params.lead && (
        <Drawer closeHref={leadsHref(params, { lead: undefined }, "/kanban")} label="Detalhes do lead">
          <Suspense key={params.lead} fallback={<LeadDetailSkeleton />}>
            <LeadDetail ctx={ctx} id={params.lead} courses={courses} situation={situation} />
          </Suspense>
        </Drawer>
      )}
    </LeadActionsProvider>
  );
}
