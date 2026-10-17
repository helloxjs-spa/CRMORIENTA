import type { Metadata } from "next";
import { ArrowLeft, Pencil, Undo2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { formatBRL } from "@/lib/money";
import { formatSaleDate, paymentLabel } from "@/lib/sales";
import { hasPermission } from "@/server/authz/permissions";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import { getSaleItemCertificates } from "@/server/modules/certificates/certificates.service";
import { getSaleInstallments } from "@/server/modules/installments/installments.service";
import { getSale, getSaleHistoryView, getSaleWithCost, type SaleItemView, type SaleItemWithCost, type SaleView } from "@/server/modules/sales/sales.service";
import { orNotFound } from "@/server/next/page";
import { requireServiceContext } from "@/server/next/session";
import { saleActionsFor } from "../policy";
import { SaleStatusBadge } from "../sale-badges";
import { SaleHistory } from "../sale-history";
import { InstallmentStatusBadge, MarkPaidButton } from "../../parcelas/installment-parts";
import { CertificateDialog } from "./certificate-dialog";
import { SaleStatusActions } from "./sale-status-actions";

export const metadata: Metadata = { title: "Venda" };

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

/**
 * Detalhe da venda. getSale aplica RBAC + escopo (fora dele: 404). Custos de
 * bolsa e lucro só são lidos (getSaleWithCost) e renderizados para quem tem
 * `finance:viewCostAndProfit` (ADMIN); os demais nunca os recebem.
 */
export default async function SalePage({ params }: PageProps<"/vendas/[saleId]">) {
  const { saleId } = await params;
  const ctx = await requireServiceContext();
  const canSeeCost = hasPermission(ctx.actor, "finance:viewCostAndProfit");
  const withCost = canSeeCost ? await orNotFound(getSaleWithCost(ctx, saleId)) : null;
  const sale: SaleView = withCost ?? (await orNotFound(getSale(ctx, saleId)));
  const items: (SaleItemView & Partial<Pick<SaleItemWithCost, "costSnapshotCents" | "profitCents">>)[] = withCost?.items ?? sale.items;
  const history = await getSaleHistoryView(ctx, sale.id);
  const actions = saleActionsFor(sale, ctx.actor);
  const now = new Date();
  // Certificados (§18): um por curso (item); só itens de venda válida recebem novo registro (C51).
  const canOperateCertificates = hasPermission(ctx.actor, "certificates:operate");
  const certificates = canOperateCertificates ? await getSaleItemCertificates(ctx, sale.id) : {};
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(now);
  // Parcelas (§12; C52): só cartão tem cronograma.
  const installments =
    sale.paymentMethod === "CARD" && hasPermission(ctx.actor, "installments:markPaid") ? await getSaleInstallments(ctx, sale.id) : null;

  return (
    <>
      <Link href="/vendas" className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="size-4" aria-hidden /> Vendas
      </Link>
      <PageHeader
        title={`Venda — ${sale.leadName}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <SaleStatusBadge status={sale.status} />
            <span>{formatSaleDate(sale.saleDate)}</span>
            <span aria-hidden>·</span>
            <Link href={`/leads?lead=${sale.leadId}`} className="text-brand-700 hover:underline">
              Ver lead
            </Link>
          </span>
        }
        actions={
          actions.length > 0 && (
            <>
              {actions.includes("edit") && (
                <ButtonLink href={`/vendas/${sale.id}/editar`} variant="secondary" size="sm">
                  <Pencil className="size-4" aria-hidden />
                  Editar
                </ButtonLink>
              )}
              {actions.includes("reverse") && <SaleStatusActions saleId={sale.id} version={sale.version} mode="reverse" />}
              {actions.includes("reactivate") && <SaleStatusActions saleId={sale.id} version={sale.version} mode="reactivate" />}
            </>
          )
        }
      />

      {sale.status === "REVERSED" && (
        <div role="status" className="mb-4 flex gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900 ring-1 ring-red-200">
          <Undo2 className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>
            <span className="font-semibold">Venda estornada.</span> Não conta em faturamento, comissão e ranking.
            {ctx.actor.role === "SELLER" ? " Para você ela é somente leitura." : " O motivo está no histórico."}
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-5 sm:grid-cols-3">
              <Info label="Total">
                <span className="text-base font-semibold tabular-nums">{formatBRL(sale.totalCents)}</span>
              </Info>
              <Info label="Pagamento">{paymentLabel(sale.paymentMethod, sale.installmentCount)}</Info>
              <Info label="Data da venda">{formatSaleDate(sale.saleDate)}</Info>
              <Info label="Responsável">{sale.sellerName}</Info>
              <Info label="Equipe da venda">{sale.teamName}</Info>
              <Info label="Supervisor">{sale.supervisorName ?? "—"}</Info>
              <Info label="Comissão">{formatBRL(sale.commissionTotalCents)}</Info>
              <Info label="Registrada por">{sale.createdByName}</Info>
              <Info label="Registrada em">{formatDateTime(sale.createdAt)}</Info>
              {withCost && (
                <>
                  <Info label="Custo das bolsas">{formatBRL(withCost.costTotalCents)}</Info>
                  <Info label="Lucro">{formatBRL(withCost.profitTotalCents)}</Info>
                </>
              )}
            </dl>
          </Card>

          <Card>
            <CardHeader title="Cursos" description={sale.items.length === 1 ? "1 curso" : `${sale.items.length} cursos`} />
            <Table>
              <thead>
                <tr>
                  <Th>Curso</Th>
                  <Th className="text-right">Preço</Th>
                  <Th className="text-right">Comissão</Th>
                  {withCost && <Th className="text-right">Custo</Th>}
                  {withCost && <Th className="text-right">Lucro</Th>}
                  {canOperateCertificates && <Th>Certificado</Th>}
                </tr>
              </thead>
              <Tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <Td className="whitespace-normal">
                      <span className="font-medium text-slate-900">{item.courseName}</span>
                      <span className="block text-xs text-slate-500">{item.institutionName}</span>
                    </Td>
                    <Td className="text-right tabular-nums">{formatBRL(item.priceCents)}</Td>
                    <Td className="text-right tabular-nums">{formatBRL(item.commissionSnapshotCents)}</Td>
                    {withCost && <Td className="text-right tabular-nums">{formatBRL(item.costSnapshotCents ?? 0)}</Td>}
                    {withCost && <Td className="text-right tabular-nums">{formatBRL(item.profitCents ?? 0)}</Td>}
                    {canOperateCertificates && (
                      <Td className="whitespace-normal">
                        {certificates[item.id] ? (
                          <>
                            <span className="text-slate-900">Entregue em {formatSaleDate(certificates[item.id].deliveredOn)}</span>
                            <span className="block text-xs text-slate-500">
                              Conclusão {formatSaleDate(certificates[item.id].completedOn)} · {certificates[item.id].certifier}
                            </span>
                          </>
                        ) : sale.status === "ACTIVE" ? (
                          <CertificateDialog saleItemId={item.id} courseName={item.courseName} today={today} />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </Td>
                    )}
                  </tr>
                ))}
              </Tbody>
            </Table>
          </Card>

          {installments && (
            <Card>
              <CardHeader title="Parcelas" description={`Cartão em ${sale.installmentCount}x · a 1ª vence um mês após a data da venda`} />
              <Table>
                <thead>
                  <tr>
                    <Th>Parcela</Th>
                    <Th>Vencimento</Th>
                    <Th className="text-right">Valor</Th>
                    <Th>Situação</Th>
                    <Th>Pagamento</Th>
                    <Th className="w-0" />
                  </tr>
                </thead>
                <Tbody>
                  {installments.map((p) => (
                    <tr key={p.id}>
                      <Td className="tabular-nums">
                        {p.number}/{p.installmentCount}
                      </Td>
                      <Td className="tabular-nums">{formatSaleDate(p.dueDate)}</Td>
                      <Td className="text-right tabular-nums">{formatBRL(p.amountCents)}</Td>
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
          )}
        </div>

        <Card>
          <CardHeader title="Histórico" />
          <div className="p-5">
            <SaleHistory history={history} now={now} />
          </div>
        </Card>
      </div>
    </>
  );
}
