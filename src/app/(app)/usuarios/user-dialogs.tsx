"use client";

import { KeyRound, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { ROLE_LABELS } from "@/lib/format";
import { createUserAction, resetPasswordAction, updateUserAction } from "./actions";

type TeamOption = { id: string; name: string };

export function CreateUserDialog({ teams }: { teams: TeamOption[] }) {
  return (
    <ActionDialog trigger={{ label: "Novo usuário", icon: Plus }} title="Novo usuário" action={createUserAction} submitLabel="Criar usuário">
      {(errors) => <CreateUserFields teams={teams} errors={errors} />}
    </ActionDialog>
  );
}

function CreateUserFields({ teams, errors }: { teams: TeamOption[]; errors: Record<string, string[]> }) {
  const [role, setRole] = useState("SELLER");
  return (
    <>
      <Field label="Nome completo" htmlFor="new-name" errors={errors.name}>
        <Input id="new-name" name="name" required maxLength={120} />
      </Field>
      <Field label="E-mail" htmlFor="new-email" errors={errors.email}>
        <Input id="new-email" name="email" type="email" required autoComplete="off" />
      </Field>
      <Field label="Senha inicial" htmlFor="new-password" errors={errors.password} hint="Mínimo de 8 caracteres. Informe ao usuário por um canal seguro.">
        <Input id="new-password" name="password" type="password" required minLength={8} autoComplete="new-password" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Perfil" htmlFor="new-role" errors={errors.role}>
          <Select id="new-role" name="role" value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        {role === "SELLER" && (
          <Field label="Equipe" htmlFor="new-team" errors={errors.teamId}>
            <Select id="new-team" name="teamId" defaultValue="">
              <option value="">Sem equipe</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {role === "SUPERVISOR" && (
        <p className="text-xs text-slate-500">Depois de criar, vincule o supervisor a uma equipe na tela Equipes.</p>
      )}
    </>
  );
}

export function EditUserDialog({ user }: { user: { id: string; name: string; email: string } }) {
  return (
    <ActionDialog trigger={{ label: "Editar", icon: Pencil, variant: "ghost", size: "sm" }} title="Editar usuário" action={updateUserAction}>
      {(errors) => (
        <>
          <input type="hidden" name="userId" value={user.id} />
          <Field label="Nome completo" htmlFor={`name-${user.id}`} errors={errors.name}>
            <Input id={`name-${user.id}`} name="name" defaultValue={user.name} required maxLength={120} />
          </Field>
          <Field label="E-mail" htmlFor={`email-${user.id}`} errors={errors.email}>
            <Input id={`email-${user.id}`} name="email" type="email" defaultValue={user.email} required />
          </Field>
        </>
      )}
    </ActionDialog>
  );
}

export function ResetPasswordDialog({ user }: { user: { id: string; name: string } }) {
  return (
    <ActionDialog
      trigger={{ label: "Senha", icon: KeyRound, variant: "ghost", size: "sm" }}
      title={`Redefinir senha de ${user.name}`}
      description="O usuário será desconectado de todas as sessões."
      action={resetPasswordAction}
      submitLabel="Redefinir senha"
    >
      {(errors) => (
        <>
          <input type="hidden" name="userId" value={user.id} />
          <Field label="Nova senha" htmlFor={`pwd-${user.id}`} errors={errors.password} hint="Mínimo de 8 caracteres.">
            <Input id={`pwd-${user.id}`} name="password" type="password" required minLength={8} autoComplete="new-password" />
          </Field>
        </>
      )}
    </ActionDialog>
  );
}
