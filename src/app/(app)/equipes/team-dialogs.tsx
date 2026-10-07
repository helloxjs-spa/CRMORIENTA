"use client";

import { ArrowRightLeft, Pencil, Plus, ShieldCheck, UserPlus } from "lucide-react";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Field, Input, Select } from "@/components/ui/form";
import {
  createTeamAction,
  moveSellerAction,
  renameTeamAction,
  setTeamSupervisorAction,
} from "./actions";

type Option = { id: string; name: string };

export function CreateTeamDialog({ supervisors }: { supervisors: Option[] }) {
  return (
    <ActionDialog
      trigger={{ label: "Nova equipe", icon: Plus }}
      title="Nova equipe"
      description="O supervisor pode ser definido agora ou depois."
      action={createTeamAction}
      submitLabel="Criar equipe"
    >
      {(errors) => (
        <>
          <Field label="Nome da equipe" htmlFor="team-name" errors={errors.name}>
            <Input id="team-name" name="name" required maxLength={80} placeholder="Ex.: Equipe Alfa" />
          </Field>
          <SupervisorSelect supervisors={supervisors} errors={errors.supervisorId} />
        </>
      )}
    </ActionDialog>
  );
}

export function RenameTeamDialog({ teamId, name }: { teamId: string; name: string }) {
  return (
    <ActionDialog trigger={{ label: "Renomear", icon: Pencil, variant: "secondary" }} title="Renomear equipe" action={renameTeamAction}>
      {(errors) => (
        <>
          <input type="hidden" name="teamId" value={teamId} />
          <Field label="Nome da equipe" htmlFor="rename-team" errors={errors.name}>
            <Input id="rename-team" name="name" defaultValue={name} required maxLength={80} />
          </Field>
        </>
      )}
    </ActionDialog>
  );
}

export function ChangeSupervisorDialog({
  teamId,
  current,
  supervisors,
}: {
  teamId: string;
  current: Option | null;
  supervisors: Option[];
}) {
  return (
    <ActionDialog
      trigger={{ label: current ? "Trocar supervisor" : "Definir supervisor", icon: ShieldCheck, variant: "secondary" }}
      title="Supervisor da equipe"
      description="Somente supervisores ativos que não lideram outra equipe aparecem na lista."
      action={setTeamSupervisorAction}
    >
      {(errors) => (
        <>
          <input type="hidden" name="teamId" value={teamId} />
          <SupervisorSelect supervisors={current ? [current, ...supervisors] : supervisors} defaultValue={current?.id} errors={errors.supervisorId} />
        </>
      )}
    </ActionDialog>
  );
}

function SupervisorSelect({ supervisors, defaultValue, errors }: { supervisors: Option[]; defaultValue?: string; errors?: string[] }) {
  return (
    <Field label="Supervisor" htmlFor="supervisorId" errors={errors} hint={supervisors.length === 0 ? "Nenhum supervisor disponível. Cadastre um em Usuários." : undefined}>
      <Select id="supervisorId" name="supervisorId" defaultValue={defaultValue ?? ""}>
        <option value="">Sem supervisor</option>
        {supervisors.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function AddSellerDialog({ teamId, sellers }: { teamId: string; sellers: (Option & { teamName: string | null })[] }) {
  return (
    <ActionDialog
      trigger={{ label: "Adicionar vendedor", icon: UserPlus }}
      title="Adicionar vendedor à equipe"
      description="O vendedor sai da equipe atual (se houver) e passa a pertencer a esta. A mudança é auditada."
      action={moveSellerAction}
      submitLabel="Adicionar"
    >
      {(errors) => (
        <>
          <input type="hidden" name="teamId" value={teamId} />
          <Field label="Vendedor" htmlFor="sellerId" errors={errors.sellerId ?? errors._}>
            <Select id="sellerId" name="sellerId" required defaultValue="">
              <option value="" disabled>
                Selecione...
              </option>
              {sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.teamName ?? "sem equipe"}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}
    </ActionDialog>
  );
}

export function MoveSellerDialog({
  seller,
  currentTeamId,
  teams,
}: {
  seller: Option;
  currentTeamId: string | null;
  teams: Option[];
}) {
  return (
    <ActionDialog
      trigger={{ label: "Mover", icon: ArrowRightLeft, variant: "ghost", size: "sm" }}
      title={`Mover ${seller.name}`}
      description="Escolha a nova equipe do vendedor. A mudança é auditada."
      action={moveSellerAction}
      submitLabel="Mover"
    >
      {(errors) => (
        <>
          <input type="hidden" name="sellerId" value={seller.id} />
          <Field label="Nova equipe" htmlFor={`move-${seller.id}`} errors={errors.teamId}>
            <Select id={`move-${seller.id}`} name="teamId" defaultValue={currentTeamId ?? ""}>
              <option value="">Sem equipe</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}
    </ActionDialog>
  );
}
