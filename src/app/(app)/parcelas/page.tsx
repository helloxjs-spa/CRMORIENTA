import type { Metadata } from "next";
import { Banknote, ChevronLeft, ChevronRight, CreditCard, SearchX } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { buttonClasses } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { INSTALLMENT_FILTER_LABELS, INSTALLMENT_PAGE_SIZES } from "@/lib/installments";
import { formatBRL } from "@/lib/money";
import { formatSaleDate } from "@/lib/sales";
import { hasPermission } from "@/server/authz/permissions";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { ServiceContext } from "@/server/context";
import { listInstallments } from "@/server/modules/installments/installments.service";
import { requireServiceContext } from "@/server/next/session";
import { InstallmentStatusBadge, MarkPaidButton } from "./installment-parts";
import {
  hasInstallmentFilters,
  installmentsHref,
  parseInstallmentsParams,
  slugOfStatus,
  STATUS_SLUGS,
  toInstallmentFilters,
  type InstallmentsParams,
} from "./search-params";

export const metadata: Metadata = { title: "Parcelas" };

/**
 * Parcelas do cartão (§12; C52). Filtros e página na URL; a consulta passa por
 * listInstallments (RBAC + escopo C50 + paginação no banco), só o cronograma
 * atual de cada venda. O pagamento é registrado aqui ou no detalhe da venda.
 */
export default async function InstallmentsPage({ searchParams }: PageProps<"/parcelas">) {
  const ctx = await requireServiceContext();
  if (!hasPermission(ctx.actor, "installments:markPaid")) notFound();
  const params = parseInstallmentsParams(await searchParams);
  const inverted = !!(params.from && params.to && params.from > params.to);

  return (
    <>
      <PageHeader
        title="Parcelas"
        description={
          ctx.actor.role === "SELLER"
            ? "Parcelas das vendas no cartão em que você é o responsável."
            : ctx.actor.role === "SUPERVISOR"
              ? "Parcelas das vendas no cartão dos vendedores da sua equipe."
              : "Parcelas de todas as vendas no cartão."
        }
      />

      <Card className="mb-4 p-4">
        <form action="/parcelas" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label="Filtrar parcelas">
          <FilterField label="Lead" htmlFor="inst-q">
            <Input id="inst-q" name="q" type="search" placeholder="Nome do lead" maxLength={120} defaultValue={params.q} />
          </FilterField>
          <FilterField label="Situação" htmlFor="inst-status">
            <Select id="inst-status" name="situacao" defaultValue={params.status ? slugOfStatus(params.status) : ""}>
              <option value="">Todas</option>
              {Object.entries(STATUS_SLUGS).map(([value, status]) => (
                <option key={value} value={value}>
                  {INSTALLMENT_FILTER_LABELS[status]}
                </option>
              ))}
            </Select>
          </FilterField>
          <div className="grid grid-cols-2 gap-2">
            <FilterField label="Vencimento de" htmlFor="inst-from">
              <Input id="inst-from" name="de" type="date" defaultValue={params.from} />
            </FilterField>
            <FilterField label="Até" htmlFor="inst-to">
              <Input id="inst-to" name="ate" type="date" defaultValue={params.to} />
            </FilterField>
          </div>
          {params.size !== INSTALLMENT_PAGE_SIZES[0] && <input type="hidden" name="por" value={params.size} />}
          <div className="flex items-end gap-2">
            <button type="submit" className={buttonClasses()}>
              Filtrar
            </button>
            {hasInstallmentFilters(params) && (
              <Link href={installmentsHref({ page: 1, size: params.size })} className="inline-flex h-10 items-center px-2 text-sm text-slate-600 hover:text-slate-900">
                Limpar filtros
              </Link>
            )}
          </div>
        </form>
        {inverted && (
          <p role="status" className="mt-3 text-sm text-amber-800">
            A data inicial é posterior à final: o período foi ignorado.
          </p>
        )}
      </Card>

      <Suspense key={installmentsHref(params)} fallback={<ResultsSkeleton />}>
        <InstallmentsResults ctx={ctx} params={params} showSeller={ctx.actor.role !== "SELLER"} />
      </Suspense>
    </>
  );
}

async function InstallmentsResults({ ctx, params, showSeller }: { ctx: ServiceContext; params: InstallmentsParams; showSeller: boolean }) {
  const result = await listInstallments(ctx, toInstallmentFilters(params));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(new Date());

  return (
    <>
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <StatCard label="Parcelas" value={result.total} icon={CreditCard} hint="Nos filtros atuais" />
        <StatCard label="Valor das parcelas" value={formatBRL(result.amountCents)} icon={Banknote} hint="Soma das parcelas nos filtros atuais" />
      </div>

      {result.total === 0 ? (
        <Card>
          <EmptyState
            icon={hasInstallmentFilters(params) ? SearchX : CreditCard}
            title={hasInstallmentFilters(params) ? "Nenhuma parcela para os filtros" : "Nenhuma parcela"}
            description={
              hasInstallmentFilters(params)
                ? "Ajuste a busca, a situação ou o período para ver outras parcelas."
                : "As parcelas são geradas ao registrar uma venda no cartão. Pix é à vista e não tem parcelas."
            }
          />
        </Card>
      ) : (
        <>
          {/* Desktop: tabela */}
          <Card className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th>Vencimento</Th>
                  <Th>Lead</Th>
                  <Th>Parcela</Th>
                  {showSeller && <Th>Responsável</Th>}
                  <Th className="text-right">Valor</Th>
                  <Th>Situação</Th>
                  <Th>Pagamento</Th>
                  <Th className="w-0" />
                </tr>
              </thead>
              <Tbody>
                {result.items.map((p) => (
                  <tr key={p.id}>
                    <Td className="tabular-nums">{formatSaleDate(p.dueDate)}</Td>
                    <Td>
                      <Link href={`/vendas/${p.saleId}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">
                        {p.leadName}
                      </Link>
                      {p.saleStatus === "REVERSED" && <span className="block text-xs text-red-700">Venda estornada</span>}
                    </Td>
                    <Td className="tabular-nums">
                      {p.number}/{p.installmentCount}
                    </Td>
                    {showSeller && <Td>{p.sellerName}</Td>}
                    <Td className="text-right font-medium tabular-nums text-slate-900">{formatBRL(p.amountCents)}</Td>
                    <Td>
                      <InstallmentStatusBadge status={p.status} dueDate={p.dueDate} today={today} />
                    </Td>
                    <Td className="text-slate-500">{p.paidAt ? `${formatDateTime(p.paidAt)} · ${p.paidByName ?? "—"}` : "—"}</Td>
                    <Td>
                      {p.status === "OPEN" && (
                        <MarkPaidButton installmentId={p.id} number={p.number} amount={formatBRL(p.amountCents)} dueDate={p.dueDate} />
                      )}
                    </Td>
                  </tr>
                ))}
              </Tbody>
            </Table>
          </Card>

          {/* Celular: cards */}
          <ul className="space-y-2 md:hidden">
            {result.items.map((p) => (
              <li key={p.id} className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/vendas/${p.saleId}`} className="min-w-0">
                    <p className="truncate font-medium text-slate-900">{p.leadName}</p>
                    <p className="text-sm tabular-nums text-slate-500">
                      Parcela {p.number}/{p.installmentCount} · vence {formatSaleDate(p.dueDate)}
                    </p>
                  </Link>
                  <p className="shrink-0 font-semibold tabular-nums text-slate-900">{formatBRL(p.amountCents)}</p>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <InstallmentStatusBadge status={p.status} dueDate={p.dueDate} today={today} />
                  {p.saleStatus === "REVERSED" && <span className="text-red-700">Venda estornada</span>}
                  {showSeller && <span>· {p.sellerName}</span>}
                  {p.paidAt && <span>· paga em {formatDateTime(p.paidAt)}</span>}
                </div>
                {p.status === "OPEN" && (
                  <div className="mt-3">
                    <MarkPaidButton installmentId={p.id} number={p.number} amount={formatBRL(p.amountCents)} dueDate={p.dueDate} />
                  </div>
                )}
              </li>
            ))}
          </ul>

          <Pagination params={params} page={result.page} pageSize={result.pageSize} total={result.total} totalPages={result.totalPages} />
        </>
      )}
    </>
  );
}

function Pagination({ params, page, pageSize, total, totalPages }: { params: InstallmentsParams; page: number; pageSize: number; total: number; totalPages: number }) {
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const link = "inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm";
  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600" aria-label="Paginação">
      <p>
        Mostrando <span className="font-medium text-slate-900">{from}</span>–<span className="font-medium text-slate-900">{to}</span> de{" "}
        <span className="font-medium text-slate-900">{total}</span> {total === 1 ? "parcela" : "parcelas"}
      </p>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500">Por página:</span>
          {INSTALLMENT_PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={installmentsHref(params, { size, page: 1 })}
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
              <Link href={installmentsHref(params, { page: page - 1 })} className={cn(link, "hover:bg-slate-100")} aria-label="Página anterior">
                <ChevronLeft className="size-4" />
              </Link>
            ) : (
              <span className={cn(link, "text-slate-300")} aria-hidden>
                <ChevronLeft className="size-4" />
              </span>
            )}
            <span className="px-2 tabular-nums" aria-current="page">
              Página {page} de {totalPages}
            </span>
            {page < totalPages ? (
              <Link href={installmentsHref(params, { page: page + 1 })} className={cn(link, "hover:bg-slate-100")} aria-label="Próxima página">
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

function ResultsSkeleton() {
  return (
    <Card className="p-4" aria-busy="true" aria-label="Carregando parcelas">
      <div className="space-y-3">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="hidden h-4 w-16 md:block" />
            <Skeleton className="ml-auto h-4 w-24" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </Card>
  );
}

function FilterField({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-slate-600">
        {label}
      </label>
      {children}
    </div>
  );
}
