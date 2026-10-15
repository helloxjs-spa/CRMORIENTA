import { Coins, HandCoins, Receipt, Target, TrendingUp, Trophy, UserPlus, Wallet } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader, StatCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/form";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatPercent, shortMonthLabel } from "@/lib/dashboard";
import { STAGE_LABELS } from "@/lib/leads";
import { formatBRL } from "@/lib/money";
import { periodLabel, periodRange, type RankingPeriod } from "@/lib/ranking";
import { hasPermission } from "@/server/authz/permissions";
import type { ServiceContext } from "@/server/context";
import { getMonthlyComparison, getSalesIndicators, type MonthlyComparisonRow } from "@/server/modules/dashboard/dashboard.service";
import { getLeadIndicators, type LeadIndicators } from "@/server/modules/leads/leads.service";
import { getRanking, type RankingResult, type SellerRankingEntry, type TeamRankingEntry } from "@/server/modules/ranking/ranking.service";

/**
 * Dashboard comercial (§17) da página inicial. Todos os números vêm dos
 * serviços (escopo e permissões no servidor): custo, lucro e comparação mensal
 * só existem no retorno para quem tem `finance:viewCostAndProfit` (ADMIN).
 */
export async function CommercialDashboard({
  ctx,
  period,
  periodError,
  currentMonth,
}: {
  ctx: ServiceContext;
  period: RankingPeriod;
  periodError?: string;
  currentMonth: string;
}) {
  const { actor } = ctx;
  const { from, to } = periodRange(period);
  const range = { dateFrom: from, dateTo: to };
  const seesFinance = hasPermission(actor, "finance:viewCostAndProfit");
  const isSeller = actor.role === "SELLER";

  const [salesIndicators, leadIndicators, byCount, byRevenue, teams, monthly] = await Promise.all([
    getSalesIndicators(ctx, range),
    getLeadIndicators(ctx, range),
    isSeller ? getRanking(ctx, { view: "sellers", criterion: "count", ...range }) : Promise.resolve(null),
    getRanking(ctx, { view: "sellers", criterion: "revenue", ...range }),
    actor.role === "ADMIN" ? getRanking(ctx, { view: "teams", criterion: "revenue", ...range }) : Promise.resolve(null),
    seesFinance ? getMonthlyComparison(ctx, { endMonth: currentMonth }) : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-6">
      <PeriodFilter period={period} periodError={periodError} currentMonth={currentMonth} />

      <section aria-labelledby="dash-sales" className="space-y-3">
        <SectionTitle id="dash-sales">Vendas válidas — {periodLabel(period)}</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Vendas válidas" value={salesIndicators.salesCount} icon={Receipt} hint="Estornadas não contam" />
          <StatCard label="Faturamento" value={formatBRL(salesIndicators.revenueCents)} icon={Wallet} hint="Soma das vendas pela data da venda" />
          <StatCard label="Comissão" value={formatBRL(salesIndicators.commissionCents)} icon={HandCoins} hint="R$ 100 por curso vendido" />
          {salesIndicators.finance && (
            <>
              <StatCard label="Custo das bolsas" value={formatBRL(salesIndicators.finance.costCents)} icon={Coins} />
              <StatCard label="Lucro" value={formatBRL(salesIndicators.finance.profitCents)} icon={TrendingUp} hint="Faturamento − custo das bolsas" />
            </>
          )}
        </div>
        {isSeller && byCount && <SellerRankingCard byCount={byCount} byRevenue={byRevenue} />}
      </section>

      <LeadSection indicators={leadIndicators} period={period} />

      {!isSeller && <SellerPerformance result={byRevenue} />}
      {teams && <TeamPerformance result={teams} />}
      {monthly && <MonthlyComparison rows={monthly} />}
    </div>
  );
}

function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="text-sm font-semibold text-slate-900">
      {children}
    </h2>
  );
}

function PeriodFilter({ period, periodError, currentMonth }: { period: RankingPeriod; periodError?: string; currentMonth: string }) {
  return (
    <Card className="space-y-3 p-4">
      <form action="/" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Período do dashboard">
        <Field label="Mês" htmlFor="dash-month">
          <Input id="dash-month" name="mes" type="month" defaultValue={period.kind === "month" ? period.month : undefined} />
        </Field>
        <div className="grid grid-cols-2 gap-2 lg:col-span-2">
          <Field label="De" htmlFor="dash-from">
            <Input id="dash-from" name="de" type="date" defaultValue={period.kind === "custom" ? period.from : undefined} />
          </Field>
          <Field label="Até" htmlFor="dash-to">
            <Input id="dash-to" name="ate" type="date" defaultValue={period.kind === "custom" ? period.to : undefined} />
          </Field>
        </div>
        <div className="flex items-end gap-2">
          <button type="submit" className={buttonClasses()}>
            Aplicar
          </button>
          <Link href={`/?mes=${currentMonth}`} className="inline-flex h-10 items-center px-2 text-sm text-slate-600 hover:text-slate-900">
            Mês atual
          </Link>
        </div>
      </form>
      <p className="text-xs text-slate-500">Intervalo personalizado: preencha De e Até (o mês é ignorado). A carteira atual e os alertas não dependem do período.</p>
      {periodError && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          {periodError} Mostrando {periodLabel(period)}.
        </p>
      )}
    </Card>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-slate-600">
        {label}
      </label>
      {children}
    </div>
  );
}

function SellerRankingCard({ byCount, byRevenue }: { byCount: RankingResult; byRevenue: RankingResult }) {
  const position = (result: RankingResult) =>
    result.mode !== "self"
      ? "—"
      : result.position === null
        ? "Sem vendas válidas no período"
        : `${result.position}º de ${result.total}${result.tied ? " (empate)" : ""}`;
  return (
    <Card>
      <CardHeader
        title="Sua posição no ranking geral"
        actions={
          <Link href="/ranking" className="text-sm font-medium text-brand-700 hover:underline">
            Ver ranking
          </Link>
        }
      />
      <dl className="grid gap-4 px-5 py-4 text-sm sm:grid-cols-2">
        <div className="flex items-center gap-3">
          <Trophy className="size-5 text-brand-500" aria-hidden />
          <div>
            <dt className="text-slate-500">Quantidade de vendas</dt>
            <dd className="font-semibold text-slate-900">{position(byCount)}</dd>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Trophy className="size-5 text-brand-500" aria-hidden />
          <div>
            <dt className="text-slate-500">Valor faturado</dt>
            <dd className="font-semibold text-slate-900">{position(byRevenue)}</dd>
          </div>
        </div>
      </dl>
    </Card>
  );
}

function LeadSection({ indicators, period }: { indicators: LeadIndicators; period: RankingPeriod }) {
  const portfolioTotal = indicators.portfolio.reduce((sum, row) => sum + row.count, 0);
  const { alerts, trashedInPeriod } = indicators;
  // Leads na Lixeira entram nos números do período (visão histórica) e isso fica identificado.
  const trashNote = trashedInPeriod > 0 ? `Inclui ${trashedInPeriod} ${trashedInPeriod === 1 ? "lead hoje na Lixeira" : "leads hoje na Lixeira"}` : undefined;
  return (
    <section aria-labelledby="dash-leads" className="space-y-3">
      <SectionTitle id="dash-leads">Leads cadastrados — {periodLabel(period)}</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Leads cadastrados" value={indicators.createdInPeriod} icon={UserPlus} hint={trashNote} />
        <StatCard label="Com venda válida" value={indicators.convertedInPeriod} icon={Receipt} hint="Cada lead conta uma vez" />
        <StatCard
          label="Conversão"
          value={formatPercent(indicators.conversionRate)}
          icon={Target}
          hint={`Leads do período com venda válida ÷ ${indicators.conversionBase} cadastrados no período fora da Lixeira`}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Carteira atual por etapa" description={`${portfolioTotal} leads ativos agora (sem a Lixeira; independe do período)`} />
          <ul className="divide-y divide-slate-100">
            {indicators.portfolio.map((row) => (
              <li key={row.stage} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span className="text-slate-700">{STAGE_LABELS[row.stage]}</span>
                <span className="font-medium tabular-nums text-slate-900">{row.count}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader
            title="Alertas operacionais"
            description="Situação atual, sem leads na Lixeira"
            actions={
              <Link href="/kanban" className="text-sm font-medium text-brand-700 hover:underline">
                Abrir Kanban
              </Link>
            }
          />
          <ul className="divide-y divide-slate-100">
            <AlertRow label="Follow-ups vencidos" value={alerts.followUpsOverdue} />
            <AlertRow label="Negociações vencidas" value={alerts.negotiationsOverdue} />
            {alerts.awaitingDecision && (
              <>
                <AlertRow label="Follow-up 3 vencido aguardando decisão" value={alerts.awaitingDecision.followUp3Expired} />
                <AlertRow label="Leads sem responsável (fila)" value={alerts.awaitingDecision.unassigned} />
              </>
            )}
          </ul>
        </Card>
      </div>
    </section>
  );
}

function AlertRow({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center justify-between px-5 py-2.5 text-sm">
      <span className="text-slate-700">{label}</span>
      <span className={cn("font-semibold tabular-nums", value > 0 ? "text-amber-700" : "text-slate-400")}>{value}</span>
    </li>
  );
}

function PerformanceTable({ entries, nameLabel }: { entries: (SellerRankingEntry | TeamRankingEntry)[]; nameLabel: string }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th className="w-20">Posição</Th>
          <Th>{nameLabel}</Th>
          <Th className="text-right">Vendas</Th>
          <Th className="text-right">Faturamento</Th>
        </tr>
      </thead>
      <Tbody>
        {entries.map((entry) => (
          <tr key={entry.id}>
            <Td className="tabular-nums">{entry.position}º</Td>
            <Td className="font-medium text-slate-900">{entry.name}</Td>
            <Td className="text-right tabular-nums">{entry.salesCount}</Td>
            <Td className="text-right tabular-nums">{formatBRL(entry.revenueCents)}</Td>
          </tr>
        ))}
      </Tbody>
    </Table>
  );
}

function SellerPerformance({ result }: { result: RankingResult }) {
  if (result.mode !== "sellers") return null;
  return (
    <Card>
      <CardHeader
        title="Desempenho por vendedor"
        description={result.scope === "team" ? "Vendas válidas da sua equipe no período (equipe registrada na venda)" : "Vendas válidas no período"}
        actions={
          <Link href="/ranking" className="text-sm font-medium text-brand-700 hover:underline">
            Ver ranking
          </Link>
        }
      />
      {result.entries.length === 0 ? (
        <EmptyState icon={Trophy} title="Nenhuma venda válida no período" description="Escolha outro período." />
      ) : (
        <PerformanceTable entries={result.entries} nameLabel="Vendedor" />
      )}
    </Card>
  );
}

function TeamPerformance({ result }: { result: RankingResult }) {
  if (result.mode !== "teams") return null;
  return (
    <Card>
      <CardHeader title="Desempenho por equipe" description="Pela equipe registrada na venda" />
      {result.entries.length === 0 ? (
        <EmptyState icon={Trophy} title="Nenhuma venda válida no período" description="Escolha outro período." />
      ) : (
        <PerformanceTable entries={result.entries} nameLabel="Equipe" />
      )}
    </Card>
  );
}

function Change({ value }: { value: number | null }) {
  return (
    <span className={cn("block text-xs", value === null ? "text-slate-400" : value >= 0 ? "text-emerald-700" : "text-red-700")}>
      {formatPercent(value, { signed: true })}
    </span>
  );
}

function MonthlyComparison({ rows }: { rows: MonthlyComparisonRow[] }) {
  return (
    <Card>
      <CardHeader title="Comparação mês a mês" description="Últimos 12 meses (o atual pode estar em andamento); variação sobre o mês anterior" />
      <Table>
        <thead>
          <tr>
            <Th>Mês</Th>
            <Th className="text-right">Vendas</Th>
            <Th className="text-right">Faturamento</Th>
            <Th className="text-right">Custo</Th>
            <Th className="text-right">Lucro</Th>
          </tr>
        </thead>
        <Tbody>
          {[...rows].reverse().map((row) => (
            <tr key={row.month}>
              <Td className="font-medium text-slate-900">{shortMonthLabel(row.month)}</Td>
              <Td className="text-right tabular-nums">
                {row.salesCount}
                <Change value={row.change.salesCount} />
              </Td>
              <Td className="text-right tabular-nums">
                {formatBRL(row.revenueCents)}
                <Change value={row.change.revenueCents} />
              </Td>
              <Td className="text-right tabular-nums">
                {formatBRL(row.costCents)}
                <Change value={row.change.costCents} />
              </Td>
              <Td className="text-right tabular-nums">
                {formatBRL(row.profitCents)}
                <Change value={row.change.profitCents} />
              </Td>
            </tr>
          ))}
        </Tbody>
      </Table>
    </Card>
  );
}
