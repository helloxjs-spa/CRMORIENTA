"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { createTeam, setTeamSupervisor, updateTeam } from "@/server/modules/teams/teams.service";
import { changeSellerTeam } from "@/server/modules/users/users.service";
import { optionalText, runAction, text } from "@/server/next/action";

// Cada action lê explicitamente apenas os campos esperados. A autorização e a
// validação acontecem nos serviços, independentemente do que a tela exibiu.

export async function createTeamAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createTeam(ctx, { name: text(formData, "name"), supervisorId: optionalText(formData, "supervisorId") });
    revalidatePath("/", "layout");
    return "Equipe criada com sucesso.";
  });
}

export async function renameTeamAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateTeam(ctx, text(formData, "teamId"), { name: text(formData, "name") });
    revalidatePath("/", "layout");
    return "Equipe atualizada.";
  });
}

export async function setTeamActiveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const active = text(formData, "active") === "true";
    await updateTeam(ctx, text(formData, "teamId"), { active });
    revalidatePath("/", "layout");
    return active ? "Equipe reativada." : "Equipe inativada.";
  });
}

export async function setTeamSupervisorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await setTeamSupervisor(ctx, text(formData, "teamId"), { supervisorId: optionalText(formData, "supervisorId") });
    revalidatePath("/", "layout");
    return "Supervisor atualizado.";
  });
}

export async function moveSellerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await changeSellerTeam(ctx, text(formData, "sellerId"), { teamId: optionalText(formData, "teamId") });
    revalidatePath("/", "layout");
    return "Vendedor movido de equipe.";
  });
}
