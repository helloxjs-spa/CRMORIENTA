"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { parseBRLToCents } from "@/lib/money";
import { createCourse, setCourseActive, updateCourse } from "@/server/modules/courses/courses.service";
import { runAction, text } from "@/server/next/action";

// As mensagens de retorno nunca incluem o custo: a resposta de uma action
// chega a quem a chamou, mesmo que não seja ADMIN (o serviço recusa antes).

/** Custo digitado em reais → centavos; undefined faz o serviço apontar o erro no campo. */
function costField(formData: FormData): number | undefined {
  return parseBRLToCents(text(formData, "scholarshipCost")) ?? undefined;
}

export async function createCourseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createCourse(ctx, { name: text(formData, "name"), scholarshipCostCents: costField(formData) });
    revalidatePath("/cursos");
    return "Curso criado com sucesso.";
  });
}

export async function updateCourseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateCourse(ctx, text(formData, "courseId"), {
      name: text(formData, "name"),
      scholarshipCostCents: costField(formData),
    });
    revalidatePath("/cursos");
    return "Curso atualizado.";
  });
}

export async function setCourseActiveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const active = text(formData, "active") === "true";
    await setCourseActive(ctx, text(formData, "courseId"), active);
    revalidatePath("/cursos");
    return active ? "Curso reativado." : "Curso desativado. Ele deixa de aparecer nas listas de cadastro.";
  });
}
