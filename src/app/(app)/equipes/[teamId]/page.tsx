import type { Metadata } from "next";
import { ArrowLeft, Users } from "lucide-react";
import Link from "next/link";
import { ActionButton } from "@/components/ui/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { hasPermission } from "@/server/authz/permissions";
import { getTeam, listAvailableSupervisors, listTeams } from "@/server/modules/teams/teams.service";
import { listUsers } from "@/server/modules/users/users.service";
import { orNotFound } from "@/server/next/page";
import { requireServiceContext } from "@/server/next/session";
import { setTeamActiveAction } from "../actions";
import { AddSellerDialog, ChangeSupervisorDialog, MoveSellerDialog, RenameTeamDialog } from "../team-dialogs";

export const metadata: Metadata = { title: "Equipe" };

export default async function TeamPage({ params }: PageProps<"/equipes/[teamId]">) {
  const { teamId } = await params;
  const ctx = await requireServiceContext();
  // getTeam aplica RBAC + escopo: supervisor de outra equipe recebe 404.
  const team = await orNotFound(getTeam(ctx, teamId));
  const canManage = hasPermission(ctx.actor, "teams:manage");

  const [supervisors, allTeams, sellers] = canManage
    ? await Promise.all([listAvailableSupervisors(ctx), listTeams(ctx), listUsers(ctx, { role: "SELLER", active: true })])
    : [[], [], []];
  const otherSellers = sellers.filter((s) => s.teamId !== team.id).map((s) => ({ id: s.id, name: s.name, teamName: s.teamName }));
  const activeTeams = allTeams.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name }));

  return (
    <>
      {canManage && (
        <Link href="/equipes" className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="size-4" aria-hidden /> Equipes
        </Link>
      )}
      <PageHeader
        title={team.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {team.active ? <Badge tone="success">Ativa</Badge> : <Badge>Inativa</Badge>}
            <span>Supervisor: {team.supervisorName ?? "não definido"}</span>
          </span>
        }
        actions={
          canManage && (
            <>
              <RenameTeamDialog teamId={team.id} name={team.name} />
              <ChangeSupervisorDialog
                teamId={team.id}
                current={team.supervisorId ? { id: team.supervisorId, name: team.supervisorName ?? "" } : null}
                supervisors={supervisors}
              />
              <ActionButton
                action={setTeamActiveAction}
                fields={{ teamId: team.id, active: String(!team.active) }}
                confirm={team.active ? "Inativar esta equipe?" : undefined}
              >
                {team.active ? "Inativar" : "Reativar"}
              </ActionButton>
            </>
          )
        }
      />

      <Card>
        <CardHeader
          title="Vendedores"
          description={`${team.members.filter((m) => m.active).length} ativo(s)`}
          actions={canManage && team.active && <AddSellerDialog teamId={team.id} sellers={otherSellers} />}
        />
        {team.members.length === 0 ? (
          <EmptyState icon={Users} title="Nenhum vendedor nesta equipe" description={canManage ? "Adicione vendedores pelo botão acima." : undefined} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Nome</Th>
                <Th>E-mail</Th>
                <Th>Status</Th>
                {canManage && (
                  <Th>
                    <span className="sr-only">Ações</span>
                  </Th>
                )}
              </tr>
            </thead>
            <Tbody>
              {team.members.map((member) => (
                <tr key={member.id}>
                  <Td className="font-medium text-slate-900">{member.name}</Td>
                  <Td>{member.email}</Td>
                  <Td>{member.active ? <Badge tone="success">Ativo</Badge> : <Badge>Inativo</Badge>}</Td>
                  {canManage && (
                    <Td className="text-right">
                      <MoveSellerDialog seller={{ id: member.id, name: member.name }} currentTeamId={team.id} teams={activeTeams} />
                    </Td>
                  )}
                </tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
