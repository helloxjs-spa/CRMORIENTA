import type { Metadata } from "next";
import { Award, ChevronLeft, ChevronRight, GraduationCap, SearchX } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { CERTIFICATE_DATE_FIELD_LABELS, CERTIFICATE_PAGE_SIZES } from "@/lib/certificates";
import { cn } from "@/lib/cn";
import { formatSaleDate } from "@/lib/sales";
import { hasPermission } from "@/server/authz/permissions";
import type { ServiceContext } from "@/server/context";
import { listCertificates, type CertificateListEntry } from "@/server/modules/certificates/certificates.service";
import { requireServiceContext } from "@/server/next/session";
import { ClickableRow } from "../leads/clickable-row";
import {
  certificatesHref,
  FIELD_SLUGS,
  hasCertificateFilters,
  parseCertificatesParams,
  toCertificateFilters,
  type CertificatesParams,
} from "./search-params";

export const metadata: Metadata = { title: "Certificados" };

/**
 * Controle operacional de certificados (§18). Filtros e página na URL; a
 * consulta passa por listCertificates (RBAC + escopo C50 + paginação no
 * banco). O registro é feito no detalhe da venda, curso a curso.
 */
export default async function CertificatesPage({ searchParams }: PageProps<"/certificados">) {
  const ctx = await requireServiceContext();
  if (!hasPermission(ctx.actor, "certificates:operate")) notFound();
  const params = parseCertificatesParams(await searchParams);
  const inverted = !!(params.from && params.to && params.from > params.to);
  const showSeller = ctx.actor.role !== "SELLER";

  return (
    <>
      <PageHeader
        title="Certificados"
        description={
          ctx.actor.role === "SELLER"
            ? "Certificados dos cursos das suas vendas."
            : ctx.actor.role === "SUPERVISOR"
              ? "Certificados das vendas dos vendedores da sua equipe."
              : "Todos os certificados registrados."
        }
      />

      <Card className="mb-4 p-4">
        <form action="/certificados" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label="Filtrar certificados">
          <FilterField label="Aluno" htmlFor="cert-q">
            <Input id="cert-q" name="q" type="search" placeholder="Nome do aluno" maxLength={120} defaultValue={params.q} />
          </FilterField>
          <FilterField label="Período por" htmlFor="cert-field">
            <Select id="cert-field" name="periodo" defaultValue={Object.keys(FIELD_SLUGS).find((k) => FIELD_SLUGS[k] === params.field)}>
              {Object.entries(FIELD_SLUGS).map(([value, field]) => (
                <option key={value} value={value}>
                  {CERTIFICATE_DATE_FIELD_LABELS[field]}
                </option>
              ))}
            </Select>
          </FilterField>
          <div className="grid grid-cols-2 gap-2">
            <FilterField label="De" htmlFor="cert-from">
              <Input id="cert-from" name="de" type="date" defaultValue={params.from} />
            </FilterField>
            <FilterField label="Até" htmlFor="cert-to">
              <Input id="cert-to" name="ate" type="date" defaultValue={params.to} />
            </FilterField>
          </div>
          {params.size !== CERTIFICATE_PAGE_SIZES[0] && <input type="hidden" name="por" value={params.size} />}
          <div className="flex items-end gap-2">
            <button type="submit" className={buttonClasses()}>
              Filtrar
            </button>
            {hasCertificateFilters(params) && (
              <Link
                href={certificatesHref({ field: "delivered", page: 1, size: params.size })}
                className="inline-flex h-10 items-center px-2 text-sm text-slate-600 hover:text-slate-900"
              >
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

      <Suspense key={certificatesHref(params)} fallback={<ResultsSkeleton />}>
        <CertificatesResults ctx={ctx} params={params} showSeller={showSeller} />
      </Suspense>
    </>
  );
}

async function CertificatesResults({ ctx, params, showSeller }: { ctx: ServiceContext; params: CertificatesParams; showSeller: boolean }) {
  const result = await listCertificates(ctx, toCertificateFilters(params));
  const period = params.from || params.to ? ` (${CERTIFICATE_DATE_FIELD_LABELS[params.field].toLowerCase()} no período)` : "";

  return (
    <>
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <StatCard label="Certificados" value={result.total} icon={Award} hint={`Nos filtros atuais${period}`} />
        <StatCard label="Alunos certificados" value={result.students} icon={GraduationCap} hint="Cada aluno conta uma vez" />
      </div>

      {result.total === 0 ? (
        <Card>
          <EmptyState
            icon={hasCertificateFilters(params) ? SearchX : Award}
            title={hasCertificateFilters(params) ? "Nenhum certificado para os filtros" : "Nenhum certificado registrado"}
            description={
              hasCertificateFilters(params)
                ? "Ajuste a busca ou o período para ver outros certificados."
                : "Registre o certificado pelo detalhe da venda, no curso que o aluno concluiu."
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
                  <Th>Aluno</Th>
                  <Th>Curso</Th>
                  {showSeller && <Th>Vendedor da venda (atual)</Th>}
                  <Th>Data da venda</Th>
                  <Th>Conclusão</Th>
                  <Th>Entrega</Th>
                  <Th>Certificadora</Th>
                </tr>
              </thead>
              <Tbody>
                {result.items.map((c) => (
                  <ClickableRow key={c.id} href={`/vendas/${c.saleId}`}>
                    <Td>
                      <Link href={`/vendas/${c.saleId}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">
                        {c.studentName}
                      </Link>
                      <SituationNote certificate={c} />
                    </Td>
                    <Td className="whitespace-normal">
                      <span className="text-slate-900">{c.courseName}</span>
                      <span className="block text-xs text-slate-500">{c.institutionName}</span>
                    </Td>
                    {showSeller && <Td>{c.sellerName}</Td>}
                    <Td className="tabular-nums text-slate-500">{formatSaleDate(c.saleDate)}</Td>
                    <Td className="tabular-nums">{formatSaleDate(c.completedOn)}</Td>
                    <Td className="tabular-nums">{formatSaleDate(c.deliveredOn)}</Td>
                    <Td>
                      <span className="block max-w-56 truncate" title={c.certifier}>
                        {c.certifier}
                      </span>
                    </Td>
                  </ClickableRow>
                ))}
              </Tbody>
            </Table>
          </Card>

          {/* Celular: cards */}
          <ul className="space-y-2 md:hidden">
            {result.items.map((c) => (
              <li key={c.id} className="relative rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <Link href={`/vendas/${c.saleId}`} className="block min-w-0 after:absolute after:inset-0">
                  <p className="truncate font-medium text-slate-900">{c.studentName}</p>
                  <p className="truncate text-sm text-slate-600">
                    {c.courseName} · {c.institutionName}
                  </p>
                </Link>
                <p className="mt-1 text-xs tabular-nums text-slate-500">
                  Venda {formatSaleDate(c.saleDate)} · Conclusão {formatSaleDate(c.completedOn)} · Entrega {formatSaleDate(c.deliveredOn)}
                </p>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {c.certifier}
                  {showSeller ? ` · ${c.sellerName}` : ""}
                </p>
                <SituationNote certificate={c} />
              </li>
            ))}
          </ul>

          <Pagination params={params} page={result.page} pageSize={result.pageSize} total={result.total} totalPages={result.totalPages} />
        </>
      )}
    </>
  );
}

/** Situação ATUAL da venda/item, só informativa (o que fazer nesses casos ainda não foi definido). */
function SituationNote({ certificate }: { certificate: CertificateListEntry }) {
  if (certificate.saleStatus === "ACTIVE" && !certificate.itemRemoved) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {certificate.saleStatus === "REVERSED" && <Badge tone="danger">Venda estornada</Badge>}
      {certificate.itemRemoved && <Badge tone="warning">Curso removido da venda</Badge>}
    </span>
  );
}

function Pagination({ params, page, pageSize, total, totalPages }: { params: CertificatesParams; page: number; pageSize: number; total: number; totalPages: number }) {
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const link = "inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm";
  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600" aria-label="Paginação">
      <p>
        Mostrando <span className="font-medium text-slate-900">{from}</span>–<span className="font-medium text-slate-900">{to}</span> de{" "}
        <span className="font-medium text-slate-900">{total}</span> {total === 1 ? "certificado" : "certificados"}
      </p>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500">Por página:</span>
          {CERTIFICATE_PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={certificatesHref(params, { size, page: 1 })}
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
              <Link href={certificatesHref(params, { page: page - 1 })} className={cn(link, "hover:bg-slate-100")} aria-label="Página anterior">
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
              <Link href={certificatesHref(params, { page: page + 1 })} className={cn(link, "hover:bg-slate-100")} aria-label="Próxima página">
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
    <Card className="p-4" aria-busy="true" aria-label="Carregando certificados">
      <div className="space-y-3">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="hidden h-4 w-48 md:block" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="ml-auto h-4 w-24" />
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
