import { AppError } from "@/server/errors";
import { getSaleAttachmentFile } from "@/server/modules/sales/attachments.service";
import { requireServiceContext } from "@/server/next/session";
import { getFileStorage } from "@/server/storage/file-storage";

/**
 * Abre um comprovante de pagamento. A sessão é revalidada no banco e o serviço
 * aplica RBAC (`sales:view`) e o escopo da venda: fora dele, 404 (sem revelar
 * se o arquivo existe). Imagens e PDF abrem no navegador; nada fica em cache.
 */
export async function GET(_request: Request, { params }: RouteContext<"/vendas/[saleId]/comprovantes/[attachmentId]">): Promise<Response> {
  const ctx = await requireServiceContext();
  const { saleId, attachmentId } = await params;
  try {
    const file = await getSaleAttachmentFile(ctx, getFileStorage(), saleId, attachmentId);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return new Response("Comprovante não encontrado.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
