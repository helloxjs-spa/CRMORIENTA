import { ChevronLeft, ChevronRight, Receipt, SearchX } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatBRL } from "@/lib/money";
import { formatSaleDate, paymentLabel, SALE_PAGE_SIZES } from "@/lib/sales";
import type { ServiceContext } from "@/server/context";
import { listSales } from "@/server/modules/sales/sales.service";
import { ClickableRow } from "../leads/clickable-row";
import { SaleStatusBadge } from "./sale-badges";
import { hasSaleFilters, salesHref, toSaleFilters, type SalesParams } from "./search-params";

export type SalesViewer = { canFilterSeller: boolean; canFilterTeam: boolean; showSeller: boolean };

/** Resultado paginado no banco (escopo, filtros, LIMIT/OFFSET no serviço). Sem custos. */
export async function SalesResults({ ctx, params, viewer }: { ctx: ServiceContext; params: SalesParams; viewer: SalesViewer }) {
  const result = await listSales(ctx, toSaleFilters(params, viewer));

  if (result.total === 0) {
    const filtered = hasSaleFilters(params);
    return (
      <Card>
        <EmptyState
          icon={filtered ? SearchX : Receipt}
          title={filtered ? "Nenhuma venda para os filtros" : "Nenhuma venda registrada"}
          description={
            filtered
              ? "Ajuste a busca ou limpe os filtros para ver outras vendas."
              : "Registre uma venda pelo botão Registrar venda ou pelo detalhe do lead."
          }
        />
      </Card>
    );
  }

  const href = (id: string) => `/vendas/${id}`;
  return (
    <>
      {/* Desktop: tabela */}
      <Card className="hidden md:block">
        <Table>
          <thead>
            <tr>
              <Th>Data</Th>
              <Th>Lead</Th>
              <Th>Cursos</Th>
              {viewer.showSeller && <Th>Responsável</Th>}
              {viewer.showSeller && <Th>Equipe</Th>}
              <Th>Pagamento</Th>
              <Th className="text-right">Total</Th>
              <Th>Situação</Th>
            </tr>
          </thead>
          <Tbody>
            {result.items.map((s) => (
              <ClickableRow key={s.id} href={href(s.id)}>
                <Td className="tabular-nums text-slate-500">{formatSaleDate(s.saleDate)}</Td>
                <Td>
                  <Link href={href(s.id)} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">
                    {s.leadName}
                  </Link>
                </Td>
                <Td>
                  <span className="block max-w-64 truncate" title={s.courseNames}>
                    {s.courseNames}
                  </span>
                  <span className="text-xs text-slate-500">{s.itemCount === 1 ? "1 curso" : `${s.itemCount} cursos`}</span>
                </Td>
                {viewer.showSeller && <Td>{s.sellerName}</Td>}
                {viewer.showSeller && <Td>{s.teamName}</Td>}
                <Td>{paymentLabel(s.paymentMethod, s.installmentCount)}</Td>
                <Td className="text-right font-medium tabular-nums text-slate-900">{formatBRL(s.totalCents)}</Td>
                <Td>
                  <SaleStatusBadge status={s.status} />
                </Td>
              </ClickableRow>
            ))}
          </Tbody>
        </Table>
      </Card>

      {/* Celular: cards */}
      <ul className="space-y-2 md:hidden">
        {result.items.map((s) => (
          <li key={s.id} className="relative rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <div className="flex items-start justify-between gap-2">
              <Link href={href(s.id)} className="min-w-0 after:absolute after:inset-0">
                <p className="truncate font-medium text-slate-900">{s.leadName}</p>
                <p className="text-sm tabular-nums text-slate-500">{formatSaleDate(s.saleDate)}</p>
              </Link>
              <p className="shrink-0 font-semibold tabular-nums text-slate-900">{formatBRL(s.totalCents)}</p>
            </div>
            <p className="mt-1 truncate text-sm text-slate-600">{s.courseNames}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <SaleStatusBadge status={s.status} />
              <span>{paymentLabel(s.paymentMethod, s.installmentCount)}</span>
              {viewer.showSeller && (
                <span>
                  · {s.sellerName} · {s.teamName}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <SalesPagination params={params} page={result.page} pageSize={result.pageSize} total={result.total} totalPages={result.totalPages} />
    </>
  );
}

function SalesPagination({ params, page, pageSize, total, totalPages }: { params: SalesParams; page: number; pageSize: number; total: number; totalPages: number }) {
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const link = "inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm";
  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600" aria-label="Paginação">
      <p>
        Mostrando <span className="font-medium text-slate-900">{from}</span>–<span className="font-medium text-slate-900">{to}</span> de{" "}
        <span className="font-medium text-slate-900">{total}</span> {total === 1 ? "venda" : "vendas"}
      </p>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500">Por página:</span>
          {SALE_PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={salesHref(params, { size, page: 1 })}
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
              <Link href={salesHref(params, { page: page - 1 })} className={cn(link, "hover:bg-slate-100")} aria-label="Página anterior">
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
              <Link href={salesHref(params, { page: page + 1 })} className={cn(link, "hover:bg-slate-100")} aria-label="Próxima página">
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

export function SalesResultsSkeleton() {
  return (
    <Card className="p-4" aria-busy="true" aria-label="Carregando vendas">
      <div className="space-y-3">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="hidden h-4 w-48 md:block" />
            <Skeleton className="ml-auto h-4 w-24" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </Card>
  );
}
