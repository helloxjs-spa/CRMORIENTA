import { z } from "zod";
import { CERTIFICATE_DATE_FIELDS } from "@/lib/certificates";
import type { CsvCell } from "@/lib/csv";
import { formatDateTime } from "@/lib/format";
import { INSTALLMENT_FILTERS, INSTALLMENT_STATUS_LABELS } from "@/lib/installments";
import { QUEUE_REASON_LABELS, STAGE_LABELS } from "@/lib/leads";
import { formatPhone } from "@/lib/phone";
import { RANKING_CRITERIA, RANKING_VIEWS } from "@/lib/ranking";
import { REPORT_FILE_SLUGS, REPORT_MAX_ROWS, REPORT_TOO_MANY_ROWS, REPORT_TYPES, type ReportType } from "@/lib/reports";
import { formatSaleDate, paymentLabel, SALE_STATUS_LABELS } from "@/lib/sales";
import { assertPermission, hasPermission } from "@/server/authz/permissions";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { ServiceContext } from "@/server/context";
import { LEAD_STATUSES, SALE_STATUSES } from "@/server/db/schema";
import { ValidationError } from "@/server/errors";
import { listCertificates } from "@/server/modules/certificates/certificates.service";
import { listInstallments } from "@/server/modules/installments/installments.service";
import { listLeads } from "@/server/modules/leads/leads.service";
import { getRanking } from "@/server/modules/ranking/ranking.service";
import { getSalesCostTotals, listSaleItemsForReport, listSales } from "@/server/modules/sales/sales.service";
import { parseInput } from "@/server/validation";

/**
 * Relatórios para Excel/CSV (Documento Mestre §20). Só `reports:export`
 * (ADMIN, SUPERVISOR; o SELLER fica negado até a dúvida #3).
 *
 * Nenhum cálculo ou escopo é refeito aqui: cada relatório chama o serviço
 * oficial do módulo (listLeads, listSales, listInstallments, listCertificates,
 * getRanking...), que aplica RBAC, escopo (C50 nas vendas e derivados) e as
 * regras de cada indicador. Custos e lucros só entram para quem tem
 * `finance:viewCostAndProfit` (ADMIN), e só são lidos nesse caso.
 */

export type Report = { filename: string; header: string[]; rows: CsvCell[][] };

const PAGE = 100;
const money = (cents: number) => ({ cents });
const date = z.iso.date({ error: "Data inválida." });
const period = { dateFrom: date.optional(), dateTo: date.optional() };

const schemas = {
  leads: z.strictObject({ ...period, status: z.enum(LEAD_STATUSES).optional() }),
  sales: z.strictObject({ ...period, status: z.enum(SALE_STATUSES).optional() }),
  items: z.strictObject({ ...period, status: z.enum(SALE_STATUSES).optional() }),
  commissions: z.strictObject(period),
  performance: z.strictObject({ dateFrom: date, dateTo: date, view: z.enum(RANKING_VIEWS), criterion: z.enum(RANKING_CRITERIA) }),
  installments: z.strictObject({ ...period, status: z.enum(INSTALLMENT_FILTERS).optional() }),
  certificates: z.strictObject({ ...period, dateField: z.enum(CERTIFICATE_DATE_FIELDS).optional() }),
} satisfies Record<ReportType, z.ZodType>;

const LEAD_STATUS_LABELS = { ACTIVE: "Ativo", TRASHED: "Lixeira" } as const;

function businessToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(new Date());
}

/** Percorre todas as páginas de um serviço paginado (mesmo escopo e filtros), com teto técnico. */
async function allPages<T>(fetch: (page: number) => Promise<{ items: T[]; total: number; totalPages: number }>): Promise<T[]> {
  const first = await fetch(1);
  if (first.total > REPORT_MAX_ROWS) throw new ValidationError(REPORT_TOO_MANY_ROWS);
  const items = [...first.items];
  for (let page = 2; page <= first.totalPages; page++) items.push(...(await fetch(page)).items);
  return items;
}

export async function buildReport(ctx: ServiceContext, rawType: unknown, rawFilters: unknown): Promise<Report> {
  assertPermission(ctx.actor, "reports:export");
  const type = parseInput(z.enum(REPORT_TYPES, { error: "Relatório inválido." }), rawType);
  const filters = parseInput(schemas[type], rawFilters) as Record<string, string | undefined>;
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    throw new ValidationError("A data inicial deve ser igual ou anterior à final.", { dateTo: ["A data inicial deve ser igual ou anterior à final."] });
  }
  const withFinance = hasPermission(ctx.actor, "finance:viewCostAndProfit");
  const filename = `relatorio-${REPORT_FILE_SLUGS[type]}-${businessToday()}.csv`;
  const { dateFrom, dateTo } = filters;

  switch (type) {
    case "leads": {
      const leads = await allPages((page) =>
        listLeads(ctx, { page, pageSize: PAGE, status: filters.status, createdFrom: dateFrom, createdTo: dateTo }),
      );
      return {
        filename,
        header: ["Nome", "Telefone", "Curso de interesse", "Instituição", "Responsável", "Equipe atual", "Etapa", "Situação", "Aguardando supervisor", "Cadastrado em"],
        rows: leads.map((l) => [
          l.name,
          formatPhone(l.phone),
          l.interestCourseName,
          l.interestCourseInstitution,
          l.ownerName ?? "Sem responsável",
          l.teamName,
          STAGE_LABELS[l.stage],
          LEAD_STATUS_LABELS[l.status],
          l.queueReason ? QUEUE_REASON_LABELS[l.queueReason] : "",
          formatDateTime(l.createdAt),
        ]),
      };
    }

    case "sales": {
      const sales = await allPages((page) => listSales(ctx, { page, pageSize: PAGE, status: filters.status, dateFrom, dateTo }));
      const costs = withFinance ? await getSalesCostTotals(ctx, sales.map((s) => s.id)) : null;
      return {
        filename,
        header: [
          "Data da venda",
          "Lead",
          "Cursos",
          "Qtd. de cursos",
          "Responsável",
          "Equipe na venda",
          "Pagamento",
          "Total",
          "Situação",
          "Estornada em",
          "Estornada por",
          "Motivo do estorno",
          ...(costs ? ["Custo das bolsas", "Lucro"] : []),
        ],
        rows: sales.map((s) => {
          const cost = costs?.get(s.id) ?? 0;
          return [
            formatSaleDate(s.saleDate),
            s.leadName,
            s.courseNames,
            s.itemCount,
            s.sellerName,
            s.teamName,
            paymentLabel(s.paymentMethod, s.installmentCount),
            money(s.totalCents),
            SALE_STATUS_LABELS[s.status],
            s.lastReversal ? formatDateTime(s.lastReversal.occurredAt) : "",
            s.lastReversal?.actorName ?? "",
            s.lastReversal?.reason ?? "",
            // Lucro = valor da venda − custo das bolsas (§13), como em getSaleWithCost.
            ...(costs ? [money(cost), money(s.totalCents - cost)] : []),
          ];
        }),
      };
    }

    case "items": {
      const items = await itemsInScope(ctx, { status: filters.status, dateFrom, dateTo });
      return {
        filename,
        header: [
          "Data da venda",
          "Situação da venda",
          "Lead",
          "Curso",
          "Instituição",
          "Responsável",
          "Equipe na venda",
          "Preço",
          "Comissão",
          ...(withFinance ? ["Custo da bolsa", "Lucro do item"] : []),
        ],
        rows: items.map((i) => [
          formatSaleDate(i.saleDate),
          SALE_STATUS_LABELS[i.status],
          i.leadName,
          i.courseName,
          i.institutionName,
          i.sellerName,
          i.teamName,
          money(i.priceCents),
          money(i.commissionSnapshotCents),
          // Lucro do item = preço − custo (mesma regra do detalhe da venda).
          ...(withFinance ? [money(i.costSnapshotCents ?? 0), money(i.priceCents - (i.costSnapshotCents ?? 0))] : []),
        ]),
      };
    }

    case "commissions": {
      // Comissão (§14, C45): itens atuais das vendas VÁLIDAS, pela data da venda — a regra do Dashboard.
      const items = await itemsInScope(ctx, { status: "ACTIVE", dateFrom, dateTo });
      const bySeller = new Map<string, { name: string; sales: Set<string>; items: number; commissionCents: number }>();
      for (const item of items) {
        const entry = bySeller.get(item.sellerId) ?? { name: item.sellerName, sales: new Set<string>(), items: 0, commissionCents: 0 };
        entry.sales.add(item.saleId);
        entry.items += 1;
        entry.commissionCents += item.commissionSnapshotCents;
        bySeller.set(item.sellerId, entry);
      }
      const rows = [...bySeller.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
      return {
        filename,
        header: ["Vendedor", "Vendas válidas", "Cursos vendidos", "Comissão"],
        rows: rows.map((r) => [r.name, r.sales.size, r.items, money(r.commissionCents)]),
      };
    }

    case "performance": {
      const result = await getRanking(ctx, { view: filters.view, criterion: filters.criterion, dateFrom, dateTo });
      if (result.mode === "teams") {
        return {
          filename,
          header: ["Posição", "Empate", "Equipe", "Supervisor atual", "Vendas válidas", "Faturamento"],
          rows: result.entries.map((e) => [e.position, e.tied ? "Sim" : "", e.name, e.supervisorName ?? "", e.salesCount, money(e.revenueCents)]),
        };
      }
      if (result.mode === "sellers") {
        return {
          filename,
          header: ["Posição", "Empate", "Vendedor", "Vendas válidas", "Faturamento"],
          rows: result.entries.map((e) => [e.position, e.tied ? "Sim" : "", e.name, e.salesCount, money(e.revenueCents)]),
        };
      }
      // "self" só existe para SELLER, que não exporta (reports:export).
      throw new ValidationError("Relatório indisponível para o seu perfil.");
    }

    case "installments": {
      const today = businessToday();
      const rows = await allPages((page) =>
        listInstallments(ctx, { page, pageSize: PAGE, status: filters.status, dueFrom: dateFrom, dueTo: dateTo }),
      );
      return {
        filename,
        header: ["Vencimento", "Lead", "Parcela", "Valor", "Situação", "Responsável", "Situação da venda", "Paga em", "Paga por"],
        rows: rows.map((p) => [
          formatSaleDate(p.dueDate),
          p.leadName,
          `${p.number}/${p.installmentCount}`,
          money(p.amountCents),
          // "Vencida" = em aberto com vencimento antes de hoje (a mesma sinalização da tela de Parcelas).
          p.status === "OPEN" && p.dueDate < today ? "Vencida" : INSTALLMENT_STATUS_LABELS[p.status],
          p.sellerName,
          SALE_STATUS_LABELS[p.saleStatus],
          p.paidAt ? formatDateTime(p.paidAt) : "",
          p.paidByName ?? "",
        ]),
      };
    }

    case "certificates": {
      const rows = await allPages((page) => listCertificates(ctx, { page, pageSize: PAGE, dateField: filters.dateField, dateFrom, dateTo }));
      return {
        filename,
        header: [
          "Aluno",
          "Curso",
          "Instituição",
          "Vendedor da venda (atual)",
          "Data da venda",
          "Conclusão",
          "Entrega",
          "Certificadora",
          "Situação da venda",
          "Curso removido da venda",
          "Registrado por",
          "Registrado em",
        ],
        rows: rows.map((c) => [
          c.studentName,
          c.courseName,
          c.institutionName,
          c.sellerName,
          formatSaleDate(c.saleDate),
          formatSaleDate(c.completedOn),
          formatSaleDate(c.deliveredOn),
          c.certifier,
          SALE_STATUS_LABELS[c.saleStatus],
          c.itemRemoved ? "Sim" : "Não",
          c.createdByName,
          formatDateTime(c.createdAt),
        ]),
      };
    }
  }
}

/** Itens atuais das vendas no escopo (mesmos filtros de listSales), com teto técnico. */
async function itemsInScope(ctx: ServiceContext, filters: { status?: string; dateFrom?: string; dateTo?: string }) {
  const items = await listSaleItemsForReport(ctx, filters, REPORT_MAX_ROWS + 1);
  if (items.length > REPORT_MAX_ROWS) throw new ValidationError(REPORT_TOO_MANY_ROWS);
  return items;
}
