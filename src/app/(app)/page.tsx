import type { Metadata } from "next";
import { Building2, ShieldCheck, UserCog, Users, UserX } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, StatCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { formatLongDate, ROLE_LABELS } from "@/lib/format";
import { parsePeriodParams } from "@/lib/ranking";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { ServiceContext } from "@/server/context";
import { getMyTeam, getTeam, listTeams } from "@/server/modules/teams/teams.service";
import { listUsers } from "@/server/modules/users/users.service";
import { requireServiceContext } from "@/server/next/session";
import { CommercialDashboard } from "./commercial-dashboard";

export const metadata: Metadata = { title: "Início" };

/** Mês atual ("AAAA-MM") no fuso único do negócio. */
function currentMonth(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone, year: "numeric", month: "2-digit" }).format(now);
}

/** Início: dashboard comercial (§17) do período na URL + estrutura da organização. */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const ctx = await requireServiceContext();
  const firstName = ctx.actor.name.split(" ")[0];
  const month = currentMonth();
  const { period, periodError } = parsePeriodParams(await searchParams, month);

  return (
    <>
      <PageHeader
        title={`Olá, ${firstName}`}
        description={
          <span className="inline-flex items-center gap-2">
            {formatLongDate(new Date())} · <Badge tone="brand">{ROLE_LABELS[ctx.actor.role]}</Badge>
          </span>
        }
      />
      <CommercialDashboard ctx={ctx} period={period} periodError={periodError} currentMonth={month} />
      <h2 className="mb-3 mt-8 text-sm font-semibold text-slate-900">Estrutura</h2>
      {ctx.actor.role === "ADMIN" && <AdminOverview ctx={ctx} />}
      {ctx.actor.role === "SUPERVISOR" && <SupervisorOverview ctx={ctx} />}
      {ctx.actor.role === "SELLER" && <SellerOverview ctx={ctx} />}
    </>
  );
}

async function AdminOverview({ ctx }: { ctx: ServiceContext }) {
  const [teams, users] = await Promise.all([listTeams(ctx), listUsers(ctx, { active: true })]);
  const supervisors = users.filter((u) => u.role === "SUPERVISOR").length;
  const sellers = users.filter((u) => u.role === "SELLER");
  const sellersWithoutTeam = sellers.filter((u) => !u.teamId).length;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Equipes ativas" value={teams.filter((t) => t.active).length} icon={Building2} />
        <StatCard label="Supervisores" value={supervisors} icon={ShieldCheck} />
        <StatCard label="Vendedores ativos" value={sellers.length} icon={Users} />
        <StatCard label="Vendedores sem equipe" value={sellersWithoutTeam} icon={UserX} hint="Não recebem leads até ter equipe" />
      </div>
      <Card>
        <CardHeader title="Equipes" description="Estrutura comercial atual" actions={<Link href="/equipes" className="text-sm font-medium text-brand-700 hover:underline">Gerenciar</Link>} />
        {teams.length === 0 ? (
          <EmptyState icon={Building2} title="Nenhuma equipe cadastrada" description="Crie equipes e defina seus supervisores em Gestão › Equipes." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Equipe</Th>
                <Th>Supervisor</Th>
                <Th className="text-right">Vendedores</Th>
              </tr>
            </thead>
            <Tbody>
              {teams.map((team) => (
                <tr key={team.id}>
                  <Td>
                    <Link href={`/equipes/${team.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {team.name}
                    </Link>
                  </Td>
                  <Td>{team.supervisorName ?? <span className="text-amber-700">Sem supervisor</span>}</Td>
                  <Td className="text-right tabular-nums">{team.sellerCount}</Td>
                </tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

async function SupervisorOverview({ ctx }: { ctx: ServiceContext }) {
  const myTeam = await getMyTeam(ctx);
  if (!myTeam) {
    return (
      <Card>
        <EmptyState icon={Building2} title="Você ainda não lidera uma equipe" description="Peça ao administrador para vinculá-lo a uma equipe." />
      </Card>
    );
  }
  const team = await getTeam(ctx, myTeam.id);
  const active = team.members.filter((m) => m.active);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Minha equipe" value={team.name} icon={Building2} />
        <StatCard label="Vendedores ativos" value={active.length} icon={Users} />
        <StatCard label="Vendedores inativos" value={team.members.length - active.length} icon={UserX} />
      </div>
      <Card>
        <CardHeader title="Vendedores do time" actions={<Link href={`/equipes/${team.id}`} className="text-sm font-medium text-brand-700 hover:underline">Ver equipe</Link>} />
        {active.length === 0 ? (
          <EmptyState icon={Users} title="Nenhum vendedor ativo" description="O administrador vincula vendedores às equipes." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {active.map((m) => (
              <li key={m.id} className="flex items-center justify-between px-5 py-3 text-sm">
                <span className="font-medium text-slate-900">{m.name}</span>
                <span className="text-slate-500">{m.email}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

async function SellerOverview({ ctx }: { ctx: ServiceContext }) {
  const team = await getMyTeam(ctx);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <StatCard label="Minha equipe" value={team?.name ?? "Sem equipe"} icon={Building2} />
      <StatCard label="Supervisor" value={team?.supervisorName ?? "—"} icon={UserCog} />
    </div>
  );
}

