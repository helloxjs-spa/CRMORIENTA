import type { Metadata } from "next";
import { Building2, Trophy, Users } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatBRL } from "@/lib/money";
import {
  parseRankingParams,
  periodLabel,
  periodRange,
  RANKING_CRITERIA,
  RANKING_CRITERION_LABELS,
  RANKING_VIEW_LABELS,
  RANKING_VIEWS,
  rankingHref,
  type RankingParams,
} from "@/lib/ranking";
import { assertPermission } from "@/server/authz/permissions";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import { getRanking, type RankingResult, type SellerRankingEntry, type TeamRankingEntry } from "@/server/modules/ranking/ranking.service";
import { getMyTeam } from "@/server/modules/teams/teams.service";
import { requireServiceContext } from "@/server/next/session";

export const metadata: Metadata = { title: "Ranking" };

/** Mês atual ("AAAA-MM") no fuso único do negócio. */
function currentMonth(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone, year: "numeric", month: "2-digit" }).format(now);
}

/**
 * Ranking (§16): critério, visão e período na URL; o cálculo e a
 * visibilidade por perfil ficam em getRanking (servidor).
 */
export default async function RankingPage({ searchParams }: PageProps<"/ranking">) {
  const ctx = await requireServiceContext();
  const { actor } = ctx;
  assertPermission(actor, "ranking:view");
  const isSeller = actor.role === "SELLER";
  const parsed = parseRankingParams(await searchParams, currentMonth());
  // O vendedor só tem a visão de vendedores (a própria posição).
  const params: RankingParams = isSeller ? { ...parsed, view: "sellers" } : parsed;
  const { from, to } = periodRange(params.period);

  const [result, myTeam] = await Promise.all([
    getRanking(ctx, { view: params.view, criterion: params.criterion, dateFrom: from, dateTo: to }),
    actor.role === "SUPERVISOR" && params.view === "sellers" ? getMyTeam(ctx) : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader
        title="Ranking"
        description={
          isSeller
            ? "Sua posição no ranking geral de vendedores da empresa."
            : actor.role === "SUPERVISOR"
              ? "Vendedores da sua equipe e ranking das equipes."
              : "Ranking de vendedores e de equipes da empresa."
        }
      />

      {!isSeller && (
        <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200" aria-label="Visões do ranking">
          {RANKING_VIEWS.map((view) => (
            <Tab key={view} href={rankingHref(params, { view })} active={params.view === view} icon={view === "sellers" ? Users : Building2}>
              {RANKING_VIEW_LABELS[view]}
            </Tab>
          ))}
        </nav>
      )}

      <Card className="mb-4 space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Critério">
          <span className="text-xs font-medium text-slate-600">Critério:</span>
          {RANKING_CRITERIA.map((criterion) => (
            <Link
              key={criterion}
              href={rankingHref(params, { criterion })}
              scroll={false}
              aria-current={params.criterion === criterion ? "true" : undefined}
              className={cn(
                "rounded-full px-3 py-1 text-sm ring-1",
                params.criterion === criterion ? "bg-brand-800 text-white ring-brand-800" : "text-slate-600 ring-slate-200 hover:bg-slate-50",
              )}
            >
              {RANKING_CRITERION_LABELS[criterion]}
            </Link>
          ))}
        </div>

        <form action="/ranking" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Período do ranking">
          <input type="hidden" name="visao" value={params.view === "teams" ? "equipes" : "vendedores"} />
          <input type="hidden" name="criterio" value={params.criterion === "revenue" ? "faturamento" : "quantidade"} />
          <FilterField label="Mês" htmlFor="ranking-month" hint="Mês atual ou anteriores.">
            <Input
              id="ranking-month"
              name="mes"
              type="month"
              defaultValue={params.period.kind === "month" ? params.period.month : undefined}
            />
          </FilterField>
          <div className="grid grid-cols-2 gap-2 sm:col-span-1 lg:col-span-2">
            <FilterField label="De" htmlFor="ranking-from">
              <Input id="ranking-from" name="de" type="date" defaultValue={params.period.kind === "custom" ? params.period.from : undefined} />
            </FilterField>
            <FilterField label="Até" htmlFor="ranking-to">
              <Input id="ranking-to" name="ate" type="date" defaultValue={params.period.kind === "custom" ? params.period.to : undefined} />
            </FilterField>
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className={buttonClasses()}>
              Aplicar
            </button>
            <Link
              href={rankingHref(params, { period: { kind: "month", month: currentMonth() } })}
              className="inline-flex h-10 items-center px-2 text-sm text-slate-600 hover:text-slate-900"
            >
              Mês atual
            </Link>
          </div>
          <p className="text-xs text-slate-500 sm:col-span-2 lg:col-span-4">
            Intervalo personalizado: preencha De e Até (o mês é ignorado). Período exibido: <strong>{periodLabel(params.period)}</strong>.
          </p>
        </form>
        {params.periodError && (
          <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
            {params.periodError} Mostrando {periodLabel(params.period)}.
          </p>
        )}
      </Card>

      <RankingResults result={result} teamName={myTeam?.name ?? null} />

      <p className="mt-3 text-xs text-slate-500">
        Só vendas válidas contam (estornadas ficam de fora). Equipes: a equipe da venda na época. Participa quem tem venda válida no
        período; empate no critério divide a mesma posição.
      </p>
    </>
  );
}

function RankingResults({ result, teamName }: { result: RankingResult; teamName: string | null }) {
  if (result.mode === "self") return <SelfPosition result={result} />;
  if (result.entries.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Trophy}
          title="Nenhuma venda válida no período"
          description={result.mode === "sellers" && result.scope === "team" && !teamName ? "Você não lidera uma equipe." : "Escolha outro período."}
        />
      </Card>
    );
  }
  const highlight = result.criterion;
  return (
    <Card className="overflow-hidden p-0">
      {result.mode === "sellers" && result.scope === "team" && teamName && (
        <p className="border-b border-slate-100 px-4 py-3 text-sm text-slate-600">
          Vendas da equipe <strong>{teamName}</strong>
        </p>
      )}
      <Table>
        <thead>
          <tr>
            <Th className="w-24">Posição</Th>
            <Th>{result.mode === "teams" ? "Equipe" : "Vendedor"}</Th>
            <Th className={cn("text-right", highlight === "count" && "text-brand-800")}>Vendas</Th>
            <Th className={cn("text-right", highlight === "revenue" && "text-brand-800")}>Faturado</Th>
          </tr>
        </thead>
        <Tbody>
          {(result.entries as (SellerRankingEntry | TeamRankingEntry)[]).map((entry) => (
            <tr key={entry.id}>
              <Td className="font-semibold tabular-nums text-slate-900">
                {entry.position}º{entry.tied && <span className="ml-1 text-xs font-normal text-slate-500">(empate)</span>}
              </Td>
              <Td>
                <span className="font-medium text-slate-900">{entry.name}</span>
                {!entry.active && <span className="ml-1 text-xs text-slate-500">({result.mode === "teams" ? "inativa" : "inativo"})</span>}
                {"supervisorName" in entry && entry.supervisorName && (
                  <span className="block text-xs text-slate-500">Supervisor atual: {entry.supervisorName}</span>
                )}
              </Td>
              <Td className={cn("text-right tabular-nums", highlight === "count" && "font-semibold text-slate-900")}>{entry.salesCount}</Td>
              <Td className={cn("text-right tabular-nums", highlight === "revenue" && "font-semibold text-slate-900")}>
                {formatBRL(entry.revenueCents)}
              </Td>
            </tr>
          ))}
        </Tbody>
      </Table>
    </Card>
  );
}

function SelfPosition({ result }: { result: Extract<RankingResult, { mode: "self" }> }) {
  if (result.position === null) {
    return (
      <Card>
        <EmptyState
          icon={Trophy}
          title="Você não tem vendas válidas neste período"
          description={`${result.total} ${result.total === 1 ? "vendedor tem" : "vendedores têm"} vendas válidas no período.`}
        />
      </Card>
    );
  }
  return (
    <Card className="p-6">
      <p className="text-sm text-slate-500">Sua posição — {RANKING_CRITERION_LABELS[result.criterion].toLowerCase()}</p>
      <p className="mt-1 text-3xl font-semibold text-slate-900">
        {result.position}º <span className="text-lg font-normal text-slate-600">de {result.total} {result.total === 1 ? "vendedor" : "vendedores"}</span>
      </p>
      {result.tied && <p className="mt-1 text-sm text-slate-500">Empatado com outro(s) vendedor(es) nesta posição.</p>}
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:max-w-sm">
        <div>
          <dt className="text-slate-500">Suas vendas válidas</dt>
          <dd className="font-semibold tabular-nums text-slate-900">{result.salesCount}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Seu faturamento</dt>
          <dd className="font-semibold tabular-nums text-slate-900">{formatBRL(result.revenueCents)}</dd>
        </div>
      </dl>
    </Card>
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

function FilterField({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-slate-600">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
