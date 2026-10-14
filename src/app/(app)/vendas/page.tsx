import type { Metadata } from "next";
import { Plus } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { buttonClasses, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { PAYMENT_METHOD_LABELS, SALE_PAGE_SIZES, SALE_STATUS_LABELS } from "@/lib/sales";
import { hasPermission } from "@/server/authz/permissions";
import { listLeadSellers } from "@/server/modules/leads/leads.service";
import { listTeams } from "@/server/modules/teams/teams.service";
import { requireServiceContext } from "@/server/next/session";
import { SalesResults, SalesResultsSkeleton, type SalesViewer } from "./sales-results";
import { hasSaleFilters, parseSalesParams, PAYMENT_SLUGS, salesHref, STATUS_SLUGS, type SalesParams } from "./search-params";

export const metadata: Metadata = { title: "Vendas" };

/**
 * Listagem de vendas. Filtros e página ficam na URL; a consulta passa por
 * listSales (RBAC + escopo + paginação no banco). Nenhum custo aparece aqui.
 */
export default async function SalesPage({ searchParams }: PageProps<"/vendas">) {
  const ctx = await requireServiceContext();
  const { actor } = ctx;
  const isAdmin = actor.role === "ADMIN";
  const canFilterSeller = hasPermission(actor, "leads:transfer");
  const viewer: SalesViewer = { canFilterSeller, canFilterTeam: isAdmin, showSeller: actor.role !== "SELLER" };
  const raw = parseSalesParams(await searchParams);
  const params: SalesParams = { ...raw, seller: canFilterSeller ? raw.seller : undefined, team: isAdmin ? raw.team : undefined };

  const [sellers, teams] = await Promise.all([
    canFilterSeller ? listLeadSellers(ctx) : Promise.resolve([]),
    isAdmin ? listTeams(ctx) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title="Vendas"
        description={
          actor.role === "SELLER"
            ? "Vendas em que você é o responsável."
            : actor.role === "SUPERVISOR"
              ? "Vendas dos vendedores da sua equipe."
              : "Todas as vendas registradas."
        }
        actions={
          hasPermission(actor, "sales:create") && (
            <ButtonLink href="/vendas/nova">
              <Plus className="size-4" aria-hidden />
              Registrar venda
            </ButtonLink>
          )
        }
      />

      <Card className="mb-4 p-4">
        <form action="/vendas" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label="Filtrar vendas">
          <FilterField label="Lead" htmlFor="sales-q">
            <Input id="sales-q" name="q" type="search" placeholder="Nome do lead" maxLength={120} defaultValue={params.q} />
          </FilterField>
          <FilterField label="Situação" htmlFor="sales-status">
            <Select id="sales-status" name="situacao" defaultValue={params.status ? slug(STATUS_SLUGS, params.status) : ""}>
              <option value="">Todas</option>
              {Object.entries(STATUS_SLUGS).map(([value, status]) => (
                <option key={value} value={value}>
                  {SALE_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField label="Pagamento" htmlFor="sales-payment">
            <Select id="sales-payment" name="pagamento" defaultValue={params.payment ? slug(PAYMENT_SLUGS, params.payment) : ""}>
              <option value="">Todos</option>
              {Object.entries(PAYMENT_SLUGS).map(([value, method]) => (
                <option key={value} value={value}>
                  {PAYMENT_METHOD_LABELS[method]}
                </option>
              ))}
            </Select>
          </FilterField>
          <div className="grid grid-cols-2 gap-2">
            <FilterField label="De" htmlFor="sales-from">
              <Input id="sales-from" name="de" type="date" defaultValue={params.from} />
            </FilterField>
            <FilterField label="Até" htmlFor="sales-to">
              <Input id="sales-to" name="ate" type="date" defaultValue={params.to} />
            </FilterField>
          </div>
          {canFilterSeller && (
            <FilterField label="Responsável" htmlFor="sales-seller">
              <Select id="sales-seller" name="vendedor" defaultValue={params.seller ?? ""}>
                <option value="">Todos</option>
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {isAdmin && s.teamName ? ` — ${s.teamName}` : ""}
                    {s.active ? "" : " (inativo)"}
                  </option>
                ))}
              </Select>
            </FilterField>
          )}
          {isAdmin && (
            <FilterField label="Equipe da venda" htmlFor="sales-team">
              <Select id="sales-team" name="equipe" defaultValue={params.team ?? ""}>
                <option value="">Todas</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.active ? "" : " (inativa)"}
                  </option>
                ))}
              </Select>
            </FilterField>
          )}
          {params.size !== SALE_PAGE_SIZES[0] && <input type="hidden" name="por" value={params.size} />}
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-1">
            <button type="submit" className={buttonClasses()}>
              Filtrar
            </button>
            {hasSaleFilters(params) && (
              <Link href={salesHref({ page: 1, size: params.size })} className="inline-flex h-10 items-center px-2 text-sm text-slate-600 hover:text-slate-900">
                Limpar filtros
              </Link>
            )}
          </div>
        </form>
      </Card>

      <Suspense key={salesHref(params)} fallback={<SalesResultsSkeleton />}>
        <SalesResults ctx={ctx} params={params} viewer={viewer} />
      </Suspense>
    </>
  );
}

const slug = <T extends string>(map: Record<string, T>, value: T) => Object.keys(map).find((k) => map[k] === value) ?? "";

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
