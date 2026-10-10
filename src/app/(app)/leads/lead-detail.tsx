import { AlertTriangle, Hourglass, Lock, Phone, SearchX, Trash2, UserX } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatRelativeDateTime } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import type { ServiceContext } from "@/server/context";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { getLead, getLeadTimeline } from "@/server/modules/leads/leads.service";
import { DeadlineBadge, StageBadge } from "./lead-badges";
import { LeadAdminActions } from "./lead-actions";
import { EditLeadDialog, type CourseChoice } from "./lead-dialogs";
import { LeadTimeline } from "./lead-timeline";
import { actionTarget } from "./leads-results";
import { NoteForm } from "./note-form";
import { leadActionsFor, moveTargetsFor, type SellerSituation } from "./policy";
import { MoveStageButtons } from "./stage-move";

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

function Notice({ icon: Icon, tone, title, children }: { icon: typeof Hourglass; tone: "brand" | "warning" | "danger"; title: string; children: ReactNode }) {
  const tones = {
    brand: "bg-brand-50 text-brand-900 ring-brand-200",
    warning: "bg-amber-50 text-amber-900 ring-amber-200",
    danger: "bg-red-50 text-red-900 ring-red-200",
  };
  return (
    <div role="status" className={`flex gap-3 rounded-xl px-4 py-3 ring-1 ${tones[tone]}`}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="text-sm">
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5 opacity-90">{children}</p>
      </div>
    </div>
  );
}

/**
 * Conteúdo do drawer do lead. getLead aplica RBAC + escopo: fora dele (ou ID
 * inválido) a mensagem é a mesma de um lead inexistente.
 */
export async function LeadDetail({
  ctx,
  id,
  courses,
  situation,
}: {
  ctx: ServiceContext;
  id: string;
  courses: CourseChoice[];
  situation: SellerSituation;
}) {
  let lead;
  try {
    lead = await getLead(ctx, id);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError || error instanceof ValidationError) {
      return (
        <EmptyState
          icon={SearchX}
          title="Lead não encontrado"
          description="Ele não existe ou não está no seu acesso. Se foi transferido ou enviado para a Lixeira, ele sai da sua carteira."
        />
      );
    }
    throw error;
  }
  const [timeline, now] = [await getLeadTimeline(ctx, id), new Date()];
  const actions = leadActionsFor(lead, ctx.actor, situation);
  const targets = moveTargetsFor(lead, ctx.actor, situation, now);
  const isSeller = ctx.actor.role === "SELLER";
  const isOwnOverdueNegotiation =
    isSeller && lead.ownerId === ctx.actor.userId && lead.status === "ACTIVE" && lead.stage === "NEGOTIATION" && !!lead.stageDueAt && lead.stageDueAt < now;
  const blockedHere =
    isSeller && situation.negotiationBlocked && !isOwnOverdueNegotiation && lead.status === "ACTIVE" && lead.queueReason !== "FOLLOW_UP_3_EXPIRED";

  return (
    <div className="space-y-6 p-6 pt-5">
      <header className="space-y-3 pr-8">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">{lead.name}</h2>
          <a href={`tel:+${lead.phone}`} className="mt-1 inline-flex items-center gap-1.5 text-sm tabular-nums text-slate-600 hover:text-brand-700">
            <Phone className="size-3.5" aria-hidden />
            {formatPhone(lead.phone)}
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {lead.status === "TRASHED" ? <Badge tone="danger">Na Lixeira</Badge> : <StageBadge stage={lead.stage} />}
          {lead.status === "ACTIVE" && <DeadlineBadge lead={lead} now={now} withDetail={false} />}
        </div>
        <MoveStageButtons leadId={lead.id} targets={targets} />
        {(actions.includes("edit") || actions.some((a) => a !== "edit" && a !== "note")) && (
          <div className="flex flex-wrap gap-2">
            {actions.includes("edit") && (
              <EditLeadDialog
                lead={{ id: lead.id, name: lead.name, phone: lead.phone, interestCourseId: lead.interestCourseId }}
                courses={courses}
              />
            )}
            <LeadAdminActions lead={actionTarget(lead)} actions={actions} variant="buttons" />
          </div>
        )}
      </header>

      {lead.queueReason === "FOLLOW_UP_3_EXPIRED" && (
        <Notice icon={Hourglass} tone="brand" title="Aguardando decisão do supervisor">
          {isSeller
            ? "O Follow-up 3 venceu. O lead continua visível para você, mas não pode mais ser movimentado: o supervisor vai redistribuí-lo ou enviá-lo para a Lixeira."
            : "O Follow-up 3 venceu. Escolha entre Redistribuir (Retrabalho com novo ciclo) ou enviar para a Lixeira."}
        </Notice>
      )}
      {isOwnOverdueNegotiation && (
        <Notice icon={AlertTriangle} tone="danger" title="Negociação vencida">
          Registre uma atualização abaixo: o prazo é renovado por mais 24 horas e, sem outras negociações vencidas, o bloqueio de cadastro e
          movimentação é liberado.
        </Notice>
      )}
      {blockedHere && (
        <Notice icon={Lock} tone="warning" title="Movimentação bloqueada">
          Você possui negociação vencida. Atualize-a para voltar a movimentar este lead.
        </Notice>
      )}
      {lead.queueReason === "UNASSIGNED" && (
        <Notice icon={UserX} tone="warning" title="Sem responsável">
          O vendedor responsável foi desativado {lead.unassignedAt ? formatRelativeDateTime(lead.unassignedAt, now) : ""}. Transfira para outro vendedor
          (a etapa e o prazo são mantidos) ou envie para a Lixeira.
        </Notice>
      )}
      {lead.status === "TRASHED" && (
        <Notice icon={Trash2} tone="danger" title="Lead na Lixeira">
          Enviado {lead.trashedAt ? formatRelativeDateTime(lead.trashedAt, now) : ""}
          {lead.trashedByName ? ` por ${lead.trashedByName}` : ""}. Para voltar a operar ou editar, recupere o lead.
        </Notice>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
        <div className="col-span-2">
          <Info label="Curso de interesse">
            {lead.interestCourseName} — {lead.interestCourseInstitution}
          </Info>
        </div>
        <Info label={lead.status === "TRASHED" ? "Etapa ao ir para a Lixeira" : "Etapa"}>
          <StageBadge stage={lead.stage} />
        </Info>
        <Info label="Prazo da etapa">{lead.stageDueAt && lead.status === "ACTIVE" ? formatDateTime(lead.stageDueAt) : "—"}</Info>
        <Info label={lead.status === "TRASHED" ? "Último responsável" : "Responsável"}>{lead.ownerName ?? "Sem responsável"}</Info>
        <Info label="Equipe">{lead.teamName}</Info>
        <Info label="Cadastro">{formatDateTime(lead.createdAt)}</Info>
        <Info label="Ciclo de atendimento">{lead.cycleNumber ? (lead.cycleNumber === 1 ? "1 · inicial" : `${lead.cycleNumber} · retrabalho`) : "—"}</Info>
      </dl>

      {actions.includes("note") && (
        <section aria-label="Adicionar atualização">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Atualização</h3>
          <NoteForm leadId={lead.id} renewsNegotiation={lead.stage === "NEGOTIATION"} />
        </section>
      )}

      <section aria-label="Histórico">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">Histórico</h3>
        <LeadTimeline events={timeline} now={now} />
      </section>
    </div>
  );
}

export function LeadDetailSkeleton() {
  return (
    <div className="space-y-6 p-6" aria-busy="true" aria-label="Carregando lead">
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-28 rounded-full" />
      </div>
      <Skeleton className="h-36 w-full rounded-xl" />
      <div className="space-y-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
