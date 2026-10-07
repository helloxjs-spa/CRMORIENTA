"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { createUser, resetUserPassword, setUserActive, updateUser } from "@/server/modules/users/users.service";
import { optionalText, runAction, text } from "@/server/next/action";

export async function createUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const role = text(formData, "role");
    await createUser(ctx, {
      name: text(formData, "name"),
      email: text(formData, "email"),
      password: text(formData, "password"),
      role,
      teamId: role === "SELLER" ? optionalText(formData, "teamId") : null,
    });
    revalidatePath("/", "layout");
    return "Usuário criado com sucesso.";
  });
}

export async function updateUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateUser(ctx, text(formData, "userId"), { name: text(formData, "name"), email: text(formData, "email") });
    revalidatePath("/", "layout");
    return "Usuário atualizado.";
  });
}

export async function resetPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await resetUserPassword(ctx, text(formData, "userId"), { password: text(formData, "password") });
    return "Senha redefinida. As sessões abertas do usuário foram encerradas.";
  });
}

export async function setUserActiveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const active = text(formData, "active") === "true";
    await setUserActive(ctx, text(formData, "userId"), active);
    revalidatePath("/", "layout");
    return active ? "Usuário reativado." : "Usuário desativado e desconectado.";
  });
}
