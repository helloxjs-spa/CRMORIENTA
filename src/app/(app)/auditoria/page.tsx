import type { Metadata } from "next";
import { ScrollText } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { AUDIT_ACTIONS, AUDIT_PAGE_SIZE, listAuditEvents, type AuditAction } from "@/server/modules/audit/audit.service";
import { orNotFound } from "@/server/next/page";
import { requireServiceContext } from "@/server/next/session";

export const metadata: Metadata = { title: "Auditoria" };

export default async function AuditPage({ searchParams }: PageProps<"/auditoria">) {
  const ctx = await requireServiceContext();
  // O serviço valida a paginação: valor inválido (texto, não inteiro, ≤ 0, fora do intervalo seguro) → 404.
  const { antes } = await searchParams;
  const raw = Array.isArray(antes) ? antes[0] : antes;
  const beforeId = raw === undefined ? undefined : Number(raw);
  const events = await orNotFound(listAuditEvents(ctx, beforeId === undefined ? {} : { beforeId }));
  const last = events.at(-1);

  return (
    <>
      <PageHeader title="Auditoria" description="Registro imutável de ações administrativas e de segurança. Mais recentes primeiro." />
      <Card>
        {events.length === 0 ? (
          <EmptyState icon={ScrollText} title="Nenhum evento registrado" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Data/hora</Th>
                <Th>Usuário</Th>
                <Th>Ação</Th>
                <Th>Detalhes</Th>
              </tr>
            </thead>
            <Tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <Td className="tabular-nums">{formatDateTime(event.occurredAt)}</Td>
                  <Td>{event.actorName ?? <span className="text-slate-400">—</span>}</Td>
                  <Td className="font-medium text-slate-900">{AUDIT_ACTIONS[event.action as AuditAction] ?? event.action}</Td>
                  <Td className="max-w-md whitespace-normal">
                    <code className="break-all font-mono text-xs text-slate-500">
                      {Object.keys(event.metadata).length > 0 ? JSON.stringify(event.metadata) : "—"}
                    </code>
                  </Td>
                </tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
      <div className="mt-4 flex justify-end gap-4 text-sm">
        {beforeId && (
          <Link href="/auditoria" className="text-slate-500 hover:text-slate-800">
            Mais recentes
          </Link>
        )}
        {last && events.length === AUDIT_PAGE_SIZE && (
          <Link href={`/auditoria?antes=${last.id}`} className="font-medium text-brand-700 hover:underline">
            Eventos anteriores →
          </Link>
        )}
      </div>
    </>
  );
}
