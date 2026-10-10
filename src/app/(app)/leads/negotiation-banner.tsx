import { AlertTriangle, ArrowRight } from "lucide-react";
import Link from "next/link";
import { formatRelativeDateTime } from "@/lib/format";
import type { NegotiationBlock } from "@/server/modules/leads/leads.service";

/**
 * Aviso persistente do vendedor com negociação vencida. O bloqueio em si é do
 * backend (createLead e moveLeadStage); aqui só se explica e se leva à
 * negociação mais antiga.
 */
export function NegotiationBanner({ block, openHref }: { block: NegotiationBlock | null; openHref: (leadId: string) => string }) {
  if (!block || block.count === 0) return null;
  const [oldest] = block.leads;
  const now = new Date();

  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-red-50 px-4 py-3 text-red-900 ring-1 ring-red-200">
      <AlertTriangle className="size-5 shrink-0 text-red-600" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">
          {block.count === 1
            ? "Você possui uma negociação vencida. Atualize-a para continuar cadastrando ou movimentando leads."
            : `Você possui ${block.count} negociações vencidas. Atualize-as para continuar cadastrando ou movimentando leads.`}
        </p>
        <p className="mt-0.5 text-red-800">
          {block.count === 1 ? "" : "Mais antiga: "}
          {oldest.name} — vencida {formatRelativeDateTime(oldest.stageDueAt, now)}
        </p>
      </div>
      <Link
        href={openHref(oldest.id)}
        scroll={false}
        className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-500"
      >
        Atualizar negociação
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}
