import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "@/server/db/errors";
import { users } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { ConflictError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { emailSchema, nameSchema, parseInput, passwordSchema } from "@/server/validation";
import { hashPassword } from "./password";

/**
 * Criação do PRIMEIRO administrador (bootstrap), usada pelo comando
 * `npm run admin:create`. Não existe ator autenticado: o evento de auditoria
 * é gravado com actor_id = null.
 *
 * Reaproveita exatamente as regras do resto da aplicação: mesmos schemas de
 * nome/e-mail/senha (e-mail normalizado em minúsculas) e o mesmo hashPassword
 * usado pelo login.
 */

export const BOOTSTRAP_DONE_MESSAGE = "O bootstrap já foi realizado: já existe um administrador.";
export const EMAIL_TAKEN_MESSAGE = "Já existe um usuário com este e-mail.";

const bootstrapSchema = z.strictObject({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});

export type BootstrapInput = z.output<typeof bootstrapSchema>;

/** Valida e normaliza a entrada (usado também pelo script antes da confirmação). */
export function parseBootstrapInput(input: unknown): BootstrapInput {
  return parseInput(bootstrapSchema, input);
}

export async function adminExists(db: Database): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.role, "ADMIN")).limit(1);
  return !!row;
}

export async function bootstrapFirstAdmin(
  db: Database,
  input: unknown,
): Promise<{ id: string; name: string; email: string }> {
  const data = parseBootstrapInput(input);
  const passwordHash = await hashPassword(data.password);

  try {
    return await db.transaction(async (tx) => {
      // Serializa bootstraps concorrentes: o segundo espera o primeiro terminar
      // e então enxerga o ADMIN já criado.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('crm:admin_bootstrap'))`);

      if (await adminExists(tx)) throw new ConflictError(BOOTSTRAP_DONE_MESSAGE);

      const [emailInUse] = await tx.select({ id: users.id }).from(users).where(eq(users.email, data.email)).limit(1);
      if (emailInUse) throw new ConflictError(EMAIL_TAKEN_MESSAGE);

      const [created] = await tx
        .insert(users)
        .values({ name: data.name, email: data.email, passwordHash, role: "ADMIN", teamId: null, active: true })
        .returning({ id: users.id, name: users.name, email: users.email });

      await recordAudit(tx, {
        actorId: null,
        action: "auth.admin_bootstrapped",
        entityType: "user",
        entityId: created.id,
        metadata: { source: "admin:create", role: "ADMIN" },
      });
      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_unique")) throw new ConflictError(EMAIL_TAKEN_MESSAGE);
    throw error;
  }
}
