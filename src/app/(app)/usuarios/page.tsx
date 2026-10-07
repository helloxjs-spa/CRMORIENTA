import type { Metadata } from "next";
import { Search, UserCog } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-button";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { ROLE_LABELS } from "@/lib/format";
import { hasPermission } from "@/server/authz/permissions";
import { USER_ROLES, type UserRole } from "@/server/db/schema";
import { listTeams } from "@/server/modules/teams/teams.service";
import { listUsers } from "@/server/modules/users/users.service";
import { requireServiceContext } from "@/server/next/session";
import { MoveSellerDialog } from "../equipes/team-dialogs";
import { setUserActiveAction } from "./actions";
import { CreateUserDialog, EditUserDialog, ResetPasswordDialog } from "./user-dialogs";

export const metadata: Metadata = { title: "Usuários" };

const ROLE_TONES: Record<UserRole, BadgeTone> = { ADMIN: "danger", SUPERVISOR: "brand", SELLER: "neutral" };

const filterInput =
  "h-10 rounded-lg border-0 bg-white px-3 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600";

export default async function UsersPage({ searchParams }: PageProps<"/usuarios">) {
  const ctx = await requireServiceContext();
  if (!hasPermission(ctx.actor, "users:manage")) notFound();

  const params = await searchParams;
  const pick = (key: string) => (typeof params[key] === "string" && params[key] ? (params[key] as string) : undefined);
  const role = USER_ROLES.find((r) => r === pick("perfil"));
  const status = pick("status");
  const teamId = pick("equipe");
  const search = pick("q");

  const teams = await listTeams(ctx);
  const validTeamId = teams.some((t) => t.id === teamId) ? teamId : undefined;
  const users = await listUsers(ctx, {
    role,
    teamId: validTeamId,
    search,
    active: status === "ativos" ? true : status === "inativos" ? false : undefined,
  });
  const activeTeams = teams.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name }));
  const hasFilters = !!(role || status || validTeamId || search);

  return (
    <>
      <PageHeader title="Usuários" description="Administradores, supervisores e vendedores com acesso ao CRM." actions={<CreateUserDialog teams={activeTeams} />} />

      <form className="mb-4 flex flex-wrap items-center gap-2" role="search">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input name="q" defaultValue={search} placeholder="Buscar por nome ou e-mail" className={`${filterInput} w-full pl-9`} aria-label="Buscar" />
        </div>
        <select name="perfil" defaultValue={role ?? ""} className={filterInput} aria-label="Perfil">
          <option value="">Todos os perfis</option>
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <select name="equipe" defaultValue={validTeamId ?? ""} className={filterInput} aria-label="Equipe">
          <option value="">Todas as equipes</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={status ?? ""} className={filterInput} aria-label="Status">
          <option value="">Todos os status</option>
          <option value="ativos">Ativos</option>
          <option value="inativos">Inativos</option>
        </select>
        <button type="submit" className={buttonClasses({ variant: "secondary" })}>
          Filtrar
        </button>
        {hasFilters && (
          <Link href="/usuarios" className="text-sm text-slate-500 hover:text-slate-800">
            Limpar
          </Link>
        )}
      </form>

      <Card>
        {users.length === 0 ? (
          <EmptyState
            icon={UserCog}
            title={hasFilters ? "Nenhum usuário encontrado" : "Nenhum usuário cadastrado"}
            description={hasFilters ? "Ajuste os filtros para ver outros resultados." : undefined}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Nome</Th>
                <Th>E-mail</Th>
                <Th>Perfil</Th>
                <Th>Equipe</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Ações</span>
                </Th>
              </tr>
            </thead>
            <Tbody>
              {users.map((user) => (
                <tr key={user.id} className={user.active ? undefined : "bg-slate-50/60 text-slate-400"}>
                  <Td className="font-medium text-slate-900">{user.name}</Td>
                  <Td>{user.email}</Td>
                  <Td>
                    <Badge tone={ROLE_TONES[user.role]}>{ROLE_LABELS[user.role]}</Badge>
                  </Td>
                  <Td>{user.role === "SELLER" ? (user.teamName ?? <Badge tone="warning">Sem equipe</Badge>) : <span className="text-slate-400">—</span>}</Td>
                  <Td>{user.active ? <Badge tone="success">Ativo</Badge> : <Badge>Inativo</Badge>}</Td>
                  <Td>
                    <div className="flex items-center justify-end gap-1">
                      <EditUserDialog user={user} />
                      <ResetPasswordDialog user={user} />
                      {user.role === "SELLER" && (
                        <MoveSellerDialog seller={{ id: user.id, name: user.name }} currentTeamId={user.teamId} teams={activeTeams} />
                      )}
                      {user.id !== ctx.actor.userId && (
                        <ActionButton
                          action={setUserActiveAction}
                          fields={{ userId: user.id, active: String(!user.active) }}
                          variant={user.active ? "ghost" : "secondary"}
                          confirm={user.active ? `Desativar ${user.name}? O acesso será bloqueado imediatamente.` : undefined}
                        >
                          {user.active ? "Desativar" : "Reativar"}
                        </ActionButton>
                      )}
                    </div>
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
