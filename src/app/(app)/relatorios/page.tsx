import type { Metadata } from "next";
import { Download } from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { CERTIFICATE_DATE_FIELD_LABELS, CERTIFICATE_DATE_FIELDS } from "@/lib/certificates";
import { INSTALLMENT_FILTER_LABELS, INSTALLMENT_FILTERS } from "@/lib/installments";
import { monthRange } from "@/lib/ranking";
import { REPORT_LABELS, REPORT_MAX_ROWS, REPORT_TYPES, type ReportType } from "@/lib/reports";
import { SALE_STATUS_LABELS } from "@/lib/sales";
import { hasPermission } from "@/server/authz/permissions";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import { requireServiceContext } from "@/server/next/session";

export const metadata: Metadata = { title: "Relatórios" };

/**
 * Exportação para Excel/CSV (§20). Cada formulário baixa o arquivo de
 * /relatorios/exportar; escopo, permissões e restrições financeiras são
 * aplicados no servidor pelo serviço de cada módulo.
 */
export default async function ReportsPage({ searchParams }: PageProps<"/relatorios">) {
  const ctx = await requireServiceContext();
  if (!hasPermission(ctx.actor, "reports:export")) notFound();
  const raw = (await searchParams).erro;
  const error = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 300);
  const withFinance = hasPermission(ctx.actor, "finance:viewCostAndProfit");
  const month = monthRange(new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(new Date()).slice(0, 7));

  return (
    <>
      <PageHeader
        title="Relatórios"
        description={`${ctx.actor.role === "SUPERVISOR" ? "Dados dos vendedores atualmente na sua equipe." : "Dados de todas as equipes."} Arquivos CSV (separados por ponto e vírgula), que abrem no Excel. Até ${REPORT_MAX_ROWS.toLocaleString("pt-BR")} linhas por arquivo.`}
      />

      {error && (
        <div role="alert" className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {REPORT_TYPES.map((type) => (
          <ReportCard key={type} type={type} note={financeNote(type, withFinance)}>
            {type === "performance" ? (
              <>
                <PeriodFields type={type} from={month.from} to={month.to} required />
                <Field label="Visão" htmlFor={`${type}-view`}>
                  <Select id={`${type}-view`} name="view" defaultValue="sellers">
                    <option value="sellers">Vendedores</option>
                    <option value="teams">Equipes</option>
                  </Select>
                </Field>
                <Field label="Critério" htmlFor={`${type}-criterion`}>
                  <Select id={`${type}-criterion`} name="criterion" defaultValue="revenue">
                    <option value="revenue">Valor faturado</option>
                    <option value="count">Quantidade de vendas</option>
                  </Select>
                </Field>
              </>
            ) : (
              <>
                <PeriodFields type={type} />
                {type === "leads" && (
                  <StatusField type={type} options={[["ACTIVE", "Ativos"], ["TRASHED", "Na Lixeira"]]} />
                )}
                {(type === "sales" || type === "items") && (
                  <StatusField type={type} options={(["ACTIVE", "REVERSED"] as const).map((s) => [s, SALE_STATUS_LABELS[s]])} />
                )}
                {type === "installments" && <StatusField type={type} options={INSTALLMENT_FILTERS.map((s) => [s, INSTALLMENT_FILTER_LABELS[s]])} />}
                {type === "certificates" && (
                  <Field label="Período por" htmlFor={`${type}-field`}>
                    <Select id={`${type}-field`} name="dateField" defaultValue="delivered">
                      {CERTIFICATE_DATE_FIELDS.map((field) => (
                        <option key={field} value={field}>
                          {CERTIFICATE_DATE_FIELD_LABELS[field]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </>
            )}
          </ReportCard>
        ))}
      </div>
    </>
  );
}

function financeNote(type: ReportType, withFinance: boolean): string | undefined {
  if (type === "commissions") return "Só vendas válidas, pela data da venda.";
  if (withFinance && (type === "sales" || type === "items")) return "Inclui custo das bolsas e lucro (somente administrador).";
  return undefined;
}

function ReportCard({ type, note, children }: { type: ReportType; note?: string; children: ReactNode }) {
  const label = REPORT_LABELS[type];
  return (
    <Card>
      <CardHeader title={label.title} description={label.description} />
      <form action="/relatorios/exportar" method="get" className="grid gap-3 px-5 pb-5 sm:grid-cols-2" aria-label={`Exportar ${label.title}`}>
        <input type="hidden" name="tipo" value={type} />
        {children}
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button type="submit" className={buttonClasses({ variant: "secondary" })}>
            <Download className="size-4" aria-hidden />
            Exportar CSV
          </button>
          {note && <p className="text-xs text-slate-500">{note}</p>}
        </div>
      </form>
    </Card>
  );
}

function PeriodFields({ type, from, to, required }: { type: ReportType; from?: string; to?: string; required?: boolean }) {
  const period = REPORT_LABELS[type].period;
  return (
    <div className="grid grid-cols-2 gap-2 sm:col-span-2">
      <Field label={`${period}: de`} htmlFor={`${type}-from`}>
        <Input id={`${type}-from`} name="dateFrom" type="date" defaultValue={from} required={required} />
      </Field>
      <Field label="Até" htmlFor={`${type}-to`}>
        <Input id={`${type}-to`} name="dateTo" type="date" defaultValue={to} required={required} />
      </Field>
    </div>
  );
}

function StatusField({ type, options }: { type: ReportType; options: readonly (readonly [string, string])[] }) {
  return (
    <Field label="Situação" htmlFor={`${type}-status`}>
      <Select id={`${type}-status`} name="status" defaultValue="">
        <option value="">Todas</option>
        {options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
    </Field>
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
