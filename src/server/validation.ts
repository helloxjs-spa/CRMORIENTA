import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/server/auth/password";

/**
 * Valida a entrada de um serviço. Os schemas devem ser `z.strictObject`, de
 * forma que campos não previstos (ex.: `role`, `teamId`, `ownerId`) sejam
 * rejeitados em vez de silenciosamente aceitos (proteção contra mass assignment).
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_";
    (fieldErrors[key] ??= []).push(issue.code === "unrecognized_keys" ? "Campo não permitido." : issue.message);
  }
  throw new ValidationError("Dados inválidos. Verifique os campos destacados.", fieldErrors);
}

export const idSchema = z.uuid({ error: "Identificador inválido." });

export const nameSchema = z
  .string()
  .trim()
  .min(2, "Informe ao menos 2 caracteres.")
  .max(120, "Use no máximo 120 caracteres.");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "E-mail inválido." }).max(254));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `A senha deve ter ao menos ${PASSWORD_MIN_LENGTH} caracteres.`)
  .max(PASSWORD_MAX_LENGTH, `A senha deve ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`);
