import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime, ROLE_LABELS } from "@/lib/format";
import { getMyTeam } from "@/server/modules/teams/teams.service";
import { getUser } from "@/server/modules/users/users.service";
import { requireServiceContext } from "@/server/next/session";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Meu perfil" };

export default async function ProfilePage() {
  const ctx = await requireServiceContext();
  const [me, team] = await Promise.all([getUser(ctx, ctx.actor.userId), getMyTeam(ctx)]);

  const rows: [string, React.ReactNode][] = [
    ["Nome", me.name],
    ["E-mail", me.email],
    ["Perfil", <Badge key="role" tone="brand">{ROLE_LABELS[me.role]}</Badge>],
    [me.role === "SUPERVISOR" ? "Equipe que lidera" : "Equipe", team?.name ?? "—"],
    ...(me.role === "SELLER" ? [["Supervisor", team?.supervisorName ?? "—"] as [string, React.ReactNode]] : []),
    ["Cadastrado em", formatDateTime(me.createdAt)],
  ];

  return (
    <>
      <PageHeader title="Meu perfil" description="Seus dados de acesso. Alterações cadastrais são feitas pelo administrador." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Dados" />
          <dl className="divide-y divide-slate-100">
            {rows.map(([label, value]) => (
              <div key={label} className="grid grid-cols-3 gap-4 px-5 py-3 text-sm">
                <dt className="text-slate-500">{label}</dt>
                <dd className="col-span-2 text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card>
          <CardHeader title="Alterar senha" description="Ao alterar, as demais sessões abertas serão encerradas." />
          <ChangePasswordForm />
        </Card>
      </div>
    </>
  );
}
