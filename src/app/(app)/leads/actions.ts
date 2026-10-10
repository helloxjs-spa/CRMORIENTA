"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import {
  addLeadNote,
  createLead,
  editLead,
  moveLeadStage,
  redistributeLead,
  restoreLead,
  transferLead,
  trashLead,
} from "@/server/modules/leads/leads.service";
import { STAGE_LABELS } from "@/lib/leads";
import { runAction, text } from "@/server/next/action";

/** Lista e Kanban mostram os mesmos leads: as duas telas são atualizadas. */
function revalidateLeadViews() {
  revalidatePath("/leads");
  revalidatePath("/kanban");
}

// Actions finas: leem campos explícitos do FormData e delegam ao serviço, que
// aplica RBAC, escopo (404 fora dele), validação e grava o histórico. Erros de
// negócio (ex.: telefone duplicado) voltam com a mensagem do serviço.

export async function createLeadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createLead(ctx, {
      name: text(formData, "name"),
      phone: text(formData, "phone"),
      interestCourseId: text(formData, "interestCourseId"),
    });
    revalidateLeadViews();
    return "Lead cadastrado.";
  });
}

export async function editLeadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await editLead(ctx, text(formData, "leadId"), {
      name: text(formData, "name"),
      phone: text(formData, "phone"),
      interestCourseId: text(formData, "interestCourseId"),
    });
    revalidateLeadViews();
    return "Dados do lead salvos.";
  });
}

export async function addLeadNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await addLeadNote(ctx, text(formData, "leadId"), { body: text(formData, "body") });
    revalidateLeadViews();
    return "Atualização registrada.";
  });
}

export async function transferLeadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await transferLead(ctx, text(formData, "leadId"), { toSellerId: text(formData, "toSellerId") });
    revalidateLeadViews();
    return "Lead transferido. Etapa e prazo foram mantidos.";
  });
}

export async function redistributeLeadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await redistributeLead(ctx, text(formData, "leadId"), { toSellerId: text(formData, "toSellerId") });
    revalidateLeadViews();
    return "Lead redistribuído em Retrabalho, com um novo ciclo.";
  });
}

export async function trashLeadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await trashLead(ctx, text(formData, "leadId"));
    revalidateLeadViews();
    return "Lead enviado para a Lixeira.";
  });
}

export async function restoreLeadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await restoreLead(ctx, text(formData, "leadId"), { toSellerId: text(formData, "toSellerId") });
    revalidateLeadViews();
    return "Lead recuperado em Retrabalho, com um novo ciclo.";
  });
}

export async function moveLeadStageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const lead = await moveLeadStage(ctx, text(formData, "leadId"), { toStage: text(formData, "toStage") });
    revalidateLeadViews();
    return `Lead movido para ${STAGE_LABELS[lead.stage]}.`;
  });
}
