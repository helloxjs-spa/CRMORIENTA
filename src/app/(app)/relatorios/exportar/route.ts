import { toCsv } from "@/lib/csv";
import { isValidDate } from "@/lib/ranking";
import { REPORT_TOO_MANY_ROWS, type ReportErrorCode } from "@/lib/reports";
import { AppError, ForbiddenError, ValidationError } from "@/server/errors";
import { buildReport } from "@/server/modules/reports/reports.service";
import { requireServiceContext } from "@/server/next/session";

/** Filtros aceitos na URL (os demais são ignorados; o serviço valida cada relatório). */
const FILTER_KEYS = ["dateFrom", "dateTo", "status", "view", "criterion", "dateField"] as const;

/**
 * Download de um relatório em CSV. A sessão é revalidada no banco e o serviço
 * aplica RBAC (`reports:export`), escopo e as restrições financeiras. Erro de
 * negócio (filtro inválido, relatório grande demais, sem permissão) volta para
 * /relatorios com um código de erro (a tela mostra a mensagem fixa dele).
 */
export async function GET(request: Request): Promise<Response> {
  const ctx = await requireServiceContext();
  const url = new URL(request.url);
  const type = url.searchParams.get("tipo") ?? "";
  const filters: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = url.searchParams.get(key)?.trim();
    if (value) filters[key] = value;
  }

  try {
    const report = await buildReport(ctx, type, filters);
    return new Response(toCsv(report.header, report.rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${report.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const back = new URL("/relatorios", url);
    back.searchParams.set("erro", errorCode(error, filters));
    return Response.redirect(back, 303);
  }
}

/** Só o código vai na URL; a tela mostra a mensagem fixa correspondente (REPORT_ERROR_MESSAGES). */
function errorCode(error: AppError, filters: Record<string, string>): ReportErrorCode {
  if (error instanceof ForbiddenError) return "permissao";
  if (error instanceof ValidationError) {
    if (error.message === REPORT_TOO_MANY_ROWS) return "limite";
    // Intervalo invertido: o serviço (e o Ranking) aponta o campo dateTo, e as duas
    // datas pedidas são válidas com De > Até. Data final inválida ou ausente também
    // aponta dateTo, mas não é intervalo invertido → "filtro".
    if (error.fieldErrors.dateTo && invertedPeriod(filters)) return "periodo";
    return "filtro";
  }
  return "falha";
}

function invertedPeriod({ dateFrom, dateTo }: Record<string, string>): boolean {
  return !!dateFrom && !!dateTo && isValidDate(dateFrom) && isValidDate(dateTo) && dateFrom > dateTo;
}
