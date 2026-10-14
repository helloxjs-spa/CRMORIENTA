import type { Metadata } from "next";
import { ArrowLeft, Contact, SearchX, Trash2, UserX } from "lucide-react";
import Link from "next/link";
import { buttonClasses, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { formatPhone } from "@/lib/phone";
import { assertPermission, hasPermission } from "@/server/authz/permissions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { listCourseFilterOptions } from "@/server/modules/courses/courses.service";
import { getLead, listLeads, type LeadView } from "@/server/modules/leads/leads.service";
import { listSaleSellerOptions } from "@/server/modules/sales/sales.service";
import { requireServiceContext } from "@/server/next/session";
import { StageBadge } from "../../leads/lead-badges";
import { SaleForm } from "./sale-form";

export const metadata: Metadata = { title: "Registrar venda" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RawParams = Record<string, string | string[] | undefined>;
const first = (raw: RawParams, key: string) => {
  const value = raw[key];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
};

/**
 * Registro de venda: 1) escolher o lead (ativo, no acesso do ator — a mesma
 * consulta da tela de Leads); 2) cursos, preços, pagamento e responsável.
 * Lead com Follow-up 3 ou negociação vencidos também pode receber venda.
 */
export default async function NewSalePage({ searchParams }: PageProps<"/vendas/nova">) {
  const ctx = await requireServiceContext();
  assertPermission(ctx.actor, "sales:create");
  const raw = await searchParams;
  const leadParam = first(raw, "lead");
  const leadId = leadParam && UUID.test(leadParam) ? leadParam : undefined;

  return (
    <>
      <Link href="/vendas" className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="size-4" aria-hidden /> Vendas
      </Link>
      <PageHeader title="Registrar venda" description="A venda leva o lead para Fechamento, com o vendedor responsável escolhido." />
      {leadId ? <SaleStep leadId={leadId} /> : <LeadPicker q={first(raw, "q")?.slice(0, 120)} />}
    </>
  );
}

async function LeadPicker({ q }: { q?: string }) {
  const ctx = await requireServiceContext();
  const result = await listLeads(ctx, { status: "ACTIVE", search: q, pageSize: 25 });
  return (
    <Card className="p-4 sm:p-6">
      <h2 className="text-sm font-semibold text-slate-900">1. Escolha o lead</h2>
      <form action="/vendas/nova" role="search" className="mt-3 flex gap-2">
        <label htmlFor="pick-lead" className="sr-only">
          Buscar lead por nome ou telefone
        </label>
        <Input id="pick-lead" name="q" type="search" placeholder="Nome ou telefone do lead" maxLength={120} defaultValue={q} />
        <button type="submit" className={buttonClasses({ variant: "secondary" })}>
          Buscar
        </button>
      </form>
      {result.total === 0 ? (
        <EmptyState
          icon={q ? SearchX : Contact}
          title={q ? "Nenhum lead encontrado" : "Nenhum lead ativo no seu acesso"}
          description="Só aparecem leads ativos (fora da Lixeira) que você pode operar."
        />
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {result.items.map((lead) => (
            <li key={lead.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-900">{lead.name}</p>
                <p className="text-sm tabular-nums text-slate-500">
                  {formatPhone(lead.phone)}
                  {lead.ownerName ? ` · ${lead.ownerName}` : " · Sem responsável"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StageBadge stage={lead.stage} />
                <ButtonLink href={`/vendas/nova?lead=${lead.id}`} size="sm">
                  Selecionar
                </ButtonLink>
              </div>
            </li>
          ))}
        </ul>
      )}
      {result.total > result.items.length && (
        <p className="mt-3 text-xs text-slate-500">Mostrando os {result.items.length} mais recentes. Refine a busca para encontrar outros.</p>
      )}
    </Card>
  );
}

async function SaleStep({ leadId }: { leadId: string }) {
  const ctx = await requireServiceContext();
  let lead: LeadView;
  try {
    lead = await getLead(ctx, leadId);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError || error instanceof ValidationError) {
      return (
        <Card>
          <EmptyState
            icon={SearchX}
            title="Lead não encontrado"
            description="Ele não existe ou não está no seu acesso."
            action={<ButtonLink href="/vendas/nova" variant="secondary">Escolher outro lead</ButtonLink>}
          />
        </Card>
      );
    }
    throw error;
  }
  if (lead.status !== "ACTIVE") {
    return (
      <Card>
        <EmptyState
          icon={Trash2}
          title="Lead na Lixeira"
          description="Lead na Lixeira não pode receber venda. Recupere-o primeiro."
          action={<ButtonLink href="/vendas/nova" variant="secondary">Escolher outro lead</ButtonLink>}
        />
      </Card>
    );
  }

  const [courses, sellers] = await Promise.all([listCourseFilterOptions(ctx), listSaleSellerOptions(ctx)]);
  const activeCourses = courses.filter((c) => c.active).map(({ id, name, institutionName }) => ({ id, name, institutionName }));
  const has = (id: string | null) => !!id && sellers.some((s) => s.id === id);
  // Padrão: o responsável atual do lead (a venda o mantém); senão, o próprio vendedor.
  const defaultSellerId = has(lead.ownerId) ? lead.ownerId! : has(ctx.actor.userId) ? ctx.actor.userId : "";

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500">Lead</p>
          <p className="truncate font-semibold text-slate-900">{lead.name}</p>
          <p className="text-sm tabular-nums text-slate-500">
            {formatPhone(lead.phone)} · {lead.ownerName ?? "Sem responsável"} · {lead.teamName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StageBadge stage={lead.stage} />
          <Link href="/vendas/nova" className="text-sm text-brand-700 hover:underline">
            Trocar lead
          </Link>
        </div>
      </Card>

      {sellers.length === 0 ? (
        <Blocked
          icon={UserX}
          title="Nenhum vendedor disponível"
          description="Não há vendedor ativo em equipe ativa que você possa escolher como responsável. Procure o administrador."
        />
      ) : activeCourses.length === 0 ? (
        <Blocked icon={SearchX} title="Nenhum curso ativo" description="Cadastre ou reative um curso antes de registrar a venda." />
      ) : (
        <Card className="p-4 sm:p-6">
          <h2 className="mb-4 text-sm font-semibold text-slate-900">2. Dados da venda</h2>
          <SaleForm
            requestId={crypto.randomUUID()}
            actorId={ctx.actor.userId}
            leadId={lead.id}
            courses={activeCourses}
            sellers={sellers.map(({ id, name, teamName }) => ({ id, name, teamName }))}
            defaultSellerId={defaultSellerId}
            canSetDate={hasPermission(ctx.actor, "sales:setDate")}
          />
        </Card>
      )}
    </div>
  );
}

function Blocked({ icon, title, description }: { icon: typeof UserX; title: string; description: string }) {
  return (
    <Card>
      <EmptyState icon={icon} title={title} description={description} />
    </Card>
  );
}
