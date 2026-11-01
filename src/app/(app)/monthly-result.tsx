import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatPercent, percentChange } from "@/lib/dashboard";
import { barWidth, goalMonthLabel, goalProgress, monthPace, monthPhase, shiftMonth, type GoalProgress } from "@/lib/goals";
import { formatBRL } from "@/lib/money";
import type { ServiceContext } from "@/server/context";
import { getMonthlyResult, type SellerResult } from "@/server/modules/goals/goals.service";
import { GoalDialog } from "./goal-dialog";

/**
 * "Resultado do mês" da página inicial: faturamento do time × meta geral,
 * ritmo do mês em andamento e cada vendedor × a própria meta. Todos veem
 * (só faturamento; custo e lucro nunca chegam aqui). As setas trocam o mês
 * pela URL (`hrefFor`), sem mexer no filtro do dashboard.
 */
export async function MonthlyResult({
  ctx,
  month,
  today,
  hrefFor,
}: {
  ctx: ServiceContext;
  month: string;
  /** "AAAA-MM-DD" no fuso do negócio. */
  today: string;
  hrefFor: (month: string) => string;
}) {
  const result = await getMonthlyResult(ctx, month);
  const label = goalMonthLabel(month);
  const phase = monthPhase(month, today);
  const progress = goalProgress(result.realizedCents, result.generalGoalCents);
  const change = percentChange(result.realizedCents, result.previousRealizedCents);

  return (
    <Card aria-labelledby="monthly-result" className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="monthly-result" className="text-base font-semibold text-slate-900">
            Resultado do mês
          </h2>
          <p className="text-sm text-slate-500">Time inteiro</p>
        </div>
        <nav aria-label="Mês do resultado" className="flex items-center gap-1 rounded-lg px-1 py-1 ring-1 ring-slate-200">
          <Link href={hrefFor(shiftMonth(month, -1))} scroll={false} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Mês anterior">
            <ChevronLeft className="size-4" aria-hidden />
          </Link>
          <span className="min-w-36 text-center text-sm font-semibold text-slate-900">{label}</span>
          <Link href={hrefFor(shiftMonth(month, 1))} scroll={false} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Próximo mês">
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        </nav>
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-3 md:gap-0 md:divide-x md:divide-slate-200">
        <Block label="Realizado" className="md:pr-6">
          <p className="text-3xl font-bold tracking-tight text-slate-900 tabular-nums sm:text-4xl">{formatBRL(result.realizedCents)}</p>
          {change !== null && (
            <p className={cn("mt-1 inline-flex items-center gap-1 text-sm font-medium", change >= 0 ? "text-emerald-600" : "text-red-600")}>
              {change >= 0 ? <ArrowUp className="size-3.5" aria-hidden /> : <ArrowDown className="size-3.5" aria-hidden />}
              {formatPercent(change)} vs mês anterior
            </p>
          )}
        </Block>

        <Block
          label="Meta"
          className="md:px-6"
          action={
            result.canEditGeneralGoal && <GoalDialog month={month} monthLabel={label} sellerId={null} goalCents={result.generalGoalCents} />
          }
        >
          {progress.kind === "none" ? (
            <p className="text-sm text-slate-500">Sem meta definida para o mês.</p>
          ) : (
            <>
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-bold text-slate-900 tabular-nums">{formatPercent(progress.percent)}</span>
                <span className="text-sm text-slate-500">de {formatBRL(result.generalGoalCents!)}</span>
              </p>
              <ProgressBar progress={progress} className="mt-2" />
              <p className="mt-2 text-sm text-slate-600">{goalStatusText(progress, phase)}</p>
            </>
          )}
        </Block>

        <Block label="Ritmo" className="md:pl-6">
          <PaceText phase={phase} today={today} realizedCents={result.realizedCents} goalCents={result.generalGoalCents} />
        </Block>
      </div>

      <div className="mt-6 border-t border-slate-200 pt-5">
        {result.sellers.length === 0 ? (
          <p className="text-sm text-slate-500">Nenhum vendedor ativo.</p>
        ) : (
          <ul className="space-y-5">
            {result.sellers.map((seller) => (
              <SellerRow key={seller.sellerId} seller={seller} month={month} monthLabel={label} phase={phase} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function Block({ label, className, action, children }: { label: string; className?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-1 flex min-h-8 items-center justify-between gap-2">
        <p className="text-sm text-slate-500">{label}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

function ProgressBar({ progress, className }: { progress: GoalProgress; className?: string }) {
  const width = barWidth(progress);
  return (
    <div
      className={cn("h-2 overflow-hidden rounded-full bg-slate-100", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(width)}
    >
      <div className="h-full rounded-full bg-linear-to-r from-teal-500 to-blue-600" style={{ width: `${width}%` }} />
    </div>
  );
}

function goalStatusText(progress: Exclude<GoalProgress, { kind: "none" }>, phase: ReturnType<typeof monthPhase>): string {
  if (progress.kind === "reached") return `Meta batida: ${formatBRL(progress.aboveCents)} acima${phase === "past" ? " — mês encerrado" : ""}`;
  return phase === "past" ? `Faltaram ${formatBRL(progress.remainingCents)} — mês encerrado` : `Faltam ${formatBRL(progress.remainingCents)}`;
}

function PaceText({
  phase,
  today,
  realizedCents,
  goalCents,
}: {
  phase: ReturnType<typeof monthPhase>;
  today: string;
  realizedCents: number;
  goalCents: number | null;
}) {
  if (phase !== "current") return <p className="text-sm text-slate-500">Ritmo só se aplica ao mês em andamento.</p>;
  const pace = monthPace(today, realizedCents, goalCents);
  const days = pace.remainingDays === 1 ? "no último dia" : `nos ${pace.remainingDays} dias restantes`;
  return (
    <div className="space-y-1.5 text-sm text-slate-600">
      <p>
        No ritmo atual, o mês fecha em <span className="font-semibold text-slate-900 tabular-nums">{formatBRL(pace.projectionCents)}</span>.
      </p>
      {pace.neededPerDayCents !== null ? (
        <p>
          Precisa de <span className="font-semibold text-slate-900 tabular-nums">{formatBRL(pace.neededPerDayCents)}/dia</span> {days} para bater a meta.
        </p>
      ) : (
        goalCents && <p className="font-medium text-emerald-600">Meta do mês já batida.</p>
      )}
    </div>
  );
}

function SellerRow({
  seller,
  month,
  monthLabel,
  phase,
}: {
  seller: SellerResult;
  month: string;
  monthLabel: string;
  phase: ReturnType<typeof monthPhase>;
}) {
  const progress = goalProgress(seller.realizedCents, seller.goalCents);
  const status =
    progress.kind === "none"
      ? "Sem meta definida"
      : progress.kind === "reached"
        ? `${formatPercent(progress.percent)} · meta batida`
        : `${formatPercent(progress.percent)} · ${phase === "past" ? "faltaram" : "faltam"} ${formatBRL(progress.remainingCents)}`;

  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <p className="text-sm font-semibold text-slate-900">{seller.name}</p>
        {seller.teamName && <span className="text-xs text-slate-500">{seller.teamName}</span>}
        {!seller.active && <Badge>Inativo</Badge>}
        {seller.canEditGoal && (
          <span className="ml-auto">
            <GoalDialog month={month} monthLabel={monthLabel} sellerId={seller.sellerId} sellerName={seller.name} goalCents={seller.goalCents} />
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="flex items-baseline gap-1.5">
          <span className="font-semibold text-slate-900 tabular-nums">{formatBRL(seller.realizedCents)}</span>
          {seller.goalCents && <span className="text-sm text-slate-500">de {formatBRL(seller.goalCents)}</span>}
        </p>
        <p className="text-sm text-slate-500 tabular-nums">{status}</p>
      </div>
      <ProgressBar progress={progress} className="mt-2" />
    </li>
  );
}
