"use client";

import { ArchiveRestore, ArrowRightLeft, RotateCcw, Trash2, type LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ActionModal } from "@/components/ui/action-modal";
import { Button } from "@/components/ui/button";
import { DropdownMenu, type MenuItem } from "@/components/ui/dropdown-menu";
import { Field, Select } from "@/components/ui/form";
import { STAGE_LABELS } from "@/lib/leads";
import type { LeadStage } from "@/server/db/schema";
import { redistributeLeadAction, restoreLeadAction, transferLeadAction, trashLeadAction } from "./actions";
import type { LeadActionKey } from "./policy";

export type SellerOption = { id: string; name: string; active: boolean; teamId: string | null; teamName: string | null };

type ActionsContext = { sellers: SellerOption[]; groupByTeam: boolean };

const Context = createContext<ActionsContext>({ sellers: [], groupByTeam: false });

/** Fornece, uma vez por página, os vendedores que o ator pode escolher como destino. */
export function LeadActionsProvider({ sellers, groupByTeam, children }: ActionsContext & { children: ReactNode }) {
  return <Context value={{ sellers, groupByTeam }}>{children}</Context>;
}

export type LeadActionTarget = {
  id: string;
  name: string;
  ownerId: string | null;
  ownerName: string | null;
  teamName: string;
  stage: LeadStage;
};

type AdminAction = Extract<LeadActionKey, "transfer" | "redistribute" | "trash" | "restore">;

const ACTION_META: Record<AdminAction, { label: string; icon: LucideIcon; tone?: "danger" }> = {
  transfer: { label: "Transferir", icon: ArrowRightLeft },
  redistribute: { label: "Redistribuir (Retrabalho)", icon: RotateCcw },
  restore: { label: "Recuperar", icon: ArchiveRestore },
  trash: { label: "Enviar para a Lixeira", icon: Trash2, tone: "danger" },
};

const ADMIN_ACTIONS: AdminAction[] = ["restore", "transfer", "redistribute", "trash"];

/**
 * Ações administrativas de um lead (SUPERVISOR na própria equipe, ADMIN em
 * todas). `actions` vem do servidor (policy.ts); o backend revalida tudo.
 * `variant="buttons"` mostra botões (drawer); o padrão é um menu "⋯".
 */
export function LeadAdminActions({
  lead,
  actions,
  variant = "menu",
}: {
  lead: LeadActionTarget;
  actions: LeadActionKey[];
  variant?: "menu" | "buttons";
}) {
  const [open, setOpen] = useState<AdminAction | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const available = ADMIN_ACTIONS.filter((a) => actions.includes(a));
  if (available.length === 0) return null;

  const items: MenuItem[] = available.map((key) => ({ ...ACTION_META[key], onSelect: () => setOpen(key) }));

  return (
    <>
      {variant === "menu" ? (
        <DropdownMenu items={items} label={`Ações do lead ${lead.name}`} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {available.map((key) => {
            const { label, icon: Icon, tone } = ACTION_META[key];
            return (
              <Button key={key} size="sm" variant="secondary" onClick={() => setOpen(key)} className={tone === "danger" ? "text-red-600" : undefined}>
                <Icon className="size-4" aria-hidden />
                {label}
              </Button>
            );
          })}
        </div>
      )}
      <TransferModal open={open === "transfer"} onClose={close} lead={lead} />
      <RedistributeModal open={open === "redistribute"} onClose={close} lead={lead} />
      <RestoreModal open={open === "restore"} onClose={close} lead={lead} />
      <TrashModal open={open === "trash"} onClose={close} lead={lead} />
    </>
  );
}

type ModalProps = { open: boolean; onClose: () => void; lead: LeadActionTarget };

function SellerSelect({ excludeId, errors }: { excludeId?: string | null; errors?: string[] }) {
  const { sellers, groupByTeam } = useContext(Context);
  const options = sellers.filter((s) => s.active && s.teamId && s.id !== excludeId);
  const id = "lead-target-seller";

  const groups = new Map<string, SellerOption[]>();
  for (const seller of options) {
    const key = groupByTeam ? (seller.teamName ?? "") : "";
    groups.set(key, [...(groups.get(key) ?? []), seller]);
  }

  return (
    <Field label="Novo vendedor responsável" htmlFor={id} errors={errors}>
      <Select id={id} name="toSellerId" required defaultValue="">
        <option value="" disabled>
          {options.length === 0 ? "Nenhum vendedor ativo disponível" : "Selecione o vendedor"}
        </option>
        {groupByTeam
          ? [...groups].map(([team, list]) => (
              <optgroup key={team} label={`Equipe ${team}`}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            ))
          : options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
      </Select>
    </Field>
  );
}

function LeadSummary({ lead }: { lead: LeadActionTarget }) {
  return (
    <dl className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 px-4 py-3 text-sm ring-1 ring-slate-200">
      <div>
        <dt className="text-xs text-slate-500">Lead</dt>
        <dd className="font-medium text-slate-900">{lead.name}</dd>
      </div>
      <div>
        <dt className="text-xs text-slate-500">Etapa</dt>
        <dd className="text-slate-800">{STAGE_LABELS[lead.stage]}</dd>
      </div>
      <div>
        <dt className="text-xs text-slate-500">Responsável atual</dt>
        <dd className="text-slate-800">{lead.ownerName ?? "Sem responsável"}</dd>
      </div>
      <div>
        <dt className="text-xs text-slate-500">Equipe</dt>
        <dd className="text-slate-800">{lead.teamName}</dd>
      </div>
    </dl>
  );
}

function TransferModal({ open, onClose, lead }: ModalProps) {
  const { groupByTeam } = useContext(Context);
  return (
    <ActionModal
      open={open}
      onClose={onClose}
      title="Transferir lead"
      description="A transferência mantém a etapa e o prazo atuais. Não cria Retrabalho."
      action={transferLeadAction}
      submitLabel="Transferir"
    >
      {(errors) => (
        <>
          <input type="hidden" name="leadId" value={lead.id} />
          <LeadSummary lead={lead} />
          <SellerSelect excludeId={lead.ownerId} errors={errors.toSellerId} />
          {groupByTeam && <p className="text-xs text-slate-500">Escolhendo um vendedor de outra equipe, o lead passa para a equipe dele.</p>}
        </>
      )}
    </ActionModal>
  );
}

function RedistributeModal({ open, onClose, lead }: ModalProps) {
  return (
    <ActionModal
      open={open}
      onClose={onClose}
      title="Redistribuir em Retrabalho"
      description="Nova tentativa comercial: o lead entra em Retrabalho com o vendedor escolhido, num novo ciclo de atendimento. O histórico anterior é preservado."
      action={redistributeLeadAction}
      submitLabel="Redistribuir"
    >
      {(errors) => (
        <>
          <input type="hidden" name="leadId" value={lead.id} />
          <LeadSummary lead={lead} />
          <SellerSelect errors={errors.toSellerId} />
        </>
      )}
    </ActionModal>
  );
}

function RestoreModal({ open, onClose, lead }: ModalProps) {
  return (
    <ActionModal
      open={open}
      onClose={onClose}
      title="Recuperar da Lixeira"
      description="O lead volta em Retrabalho para o vendedor escolhido, com um novo ciclo de atendimento. O histórico anterior é preservado."
      action={restoreLeadAction}
      submitLabel="Recuperar"
    >
      {(errors) => (
        <>
          <input type="hidden" name="leadId" value={lead.id} />
          <LeadSummary lead={lead} />
          <SellerSelect errors={errors.toSellerId} />
        </>
      )}
    </ActionModal>
  );
}

function TrashModal({ open, onClose, lead }: ModalProps) {
  return (
    <ActionModal
      open={open}
      onClose={onClose}
      title="Enviar para a Lixeira?"
      description="O lead sai da operação, mas nada é apagado: o histórico é preservado, o telefone continua ocupado e o supervisor ou o administrador podem recuperá-lo."
      action={trashLeadAction}
      submitLabel="Enviar para a Lixeira"
      submitVariant="danger"
    >
      {() => (
        <>
          <input type="hidden" name="leadId" value={lead.id} />
          <LeadSummary lead={lead} />
        </>
      )}
    </ActionModal>
  );
}
