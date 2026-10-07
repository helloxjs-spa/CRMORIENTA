import type { Metadata } from "next";
import { Building2, ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { listAvailableSupervisors, listTeams } from "@/server/modules/teams/teams.service";
import { requireServiceContext } from "@/server/next/session";
import { CreateTeamDialog } from "./team-dialogs";

export const metadata: Metadata = { title: "Equipes" };

export default async function TeamsPage() {
  const ctx = await requireServiceContext();
  // Supervisor tem uma única equipe: vai direto para ela.
  if (ctx.actor.role === "SUPERVISOR" && ctx.actor.supervisedTeamId) redirect(`/equipes/${ctx.actor.supervisedTeamId}`);
  if (ctx.actor.role !== "ADMIN") notFound();

  const [teams, supervisors] = await Promise.all([listTeams(ctx), listAvailableSupervisors(ctx)]);

  return (
    <>
      <PageHeader
        title="Equipes"
        description="Times comerciais, seus supervisores e vendedores."
        actions={<CreateTeamDialog supervisors={supervisors} />}
      />
      <Card>
        {teams.length === 0 ? (
          <EmptyState icon={Building2} title="Nenhuma equipe cadastrada" description="Crie a primeira equipe e defina o supervisor responsável." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Equipe</Th>
                <Th>Supervisor</Th>
                <Th className="text-right">Vendedores ativos</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Abrir</span>
                </Th>
              </tr>
            </thead>
            <Tbody>
              {teams.map((team) => (
                <tr key={team.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={`/equipes/${team.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {team.name}
                    </Link>
                  </Td>
                  <Td>{team.supervisorName ?? <Badge tone="warning">Sem supervisor</Badge>}</Td>
                  <Td className="text-right tabular-nums">{team.sellerCount}</Td>
                  <Td>{team.active ? <Badge tone="success">Ativa</Badge> : <Badge>Inativa</Badge>}</Td>
                  <Td className="text-right">
                    <Link href={`/equipes/${team.id}`} className="inline-flex text-slate-400 hover:text-brand-700" aria-label={`Abrir ${team.name}`}>
                      <ChevronRight className="size-5" />
                    </Link>
                  </Td>
                </tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
