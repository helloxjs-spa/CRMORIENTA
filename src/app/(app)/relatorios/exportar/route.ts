import { toCsv } from "@/lib/csv";
import { AppError } from "@/server/errors";
import { buildReport } from "@/server/modules/reports/reports.service";
import { requireServiceContext } from "@/server/next/session";

/** Filtros aceitos na URL (os demais são ignorados; o serviço valida cada relatório). */
const FILTER_KEYS = ["dateFrom", "dateTo", "status", "view", "criterion", "dateField"] as const;

/**
 * Download de um relatório em CSV. A sessão é revalidada no banco e o serviço
 * aplica RBAC (`reports:export`), escopo e as restrições financeiras. Erro de
 * negócio (filtro inválido, relatório grande demais, sem permissão) volta para
 * /relatorios com a mensagem.
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
    back.searchParams.set("erro", error.message);
    return Response.redirect(back, 303);
  }
}
