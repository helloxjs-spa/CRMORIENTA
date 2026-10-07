import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ServiceContext } from "@/server/context";
import { users } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { emailSchema, parseInput, passwordSchema } from "@/server/validation";
import { getDummyHash, hashPassword, verifyPassword } from "./password";
import { clearAttempts, isRateLimited, registerFailedAttempt } from "./rate-limit";
import { createSession, revokeAllUserSessions } from "./session";

const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1, "Informe a senha.").max(200),
});

const INVALID_CREDENTIALS = "E-mail ou senha inválidos.";

export async function login(
  db: Database,
  input: unknown,
  meta: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const { email, password } = parseInput(loginSchema, input);
  const limitKey = `${email}|${meta.ipAddress ?? ""}`;
  if (isRateLimited(limitKey)) {
    throw new ValidationError("Muitas tentativas de login. Aguarde alguns minutos e tente novamente.");
  }

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, active: users.active })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Sempre executa a verificação de senha para não revelar, pelo tempo de
  // resposta, se o e-mail existe.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

  if (!user || !passwordOk || !user.active) {
    registerFailedAttempt(limitKey);
    await recordAudit(db, {
      actorId: user?.id ?? null,
      action: "auth.login_failed",
      entityType: "session",
      metadata: { email, ipAddress: meta.ipAddress ?? null, reason: !user ? "unknown_email" : !passwordOk ? "wrong_password" : "inactive_user" },
    });
    throw new ValidationError(INVALID_CREDENTIALS);
  }

  clearAttempts(limitKey);
  const session = await createSession(db, user.id, meta);
  await recordAudit(db, {
    actorId: user.id,
    action: "auth.login",
    entityType: "session",
    entityId: user.id,
    metadata: { ipAddress: meta.ipAddress ?? null },
  });
  return session;
}

const changePasswordSchema = z
  .strictObject({
    currentPassword: z.string().min(1, "Informe a senha atual."),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "As senhas não conferem.",
  });

/** Troca a senha do próprio usuário e encerra todas as sessões dele. */
export async function changeOwnPassword({ db, actor }: ServiceContext, input: unknown): Promise<void> {
  const data = parseInput(changePasswordSchema, input);
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  if (!user || !(await verifyPassword(data.currentPassword, user.passwordHash))) {
    throw new ValidationError("Senha atual incorreta.", { currentPassword: ["Senha atual incorreta."] });
  }
  const passwordHash = await hashPassword(data.newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, actor.userId));
    await revokeAllUserSessions(tx, actor.userId);
    await recordAudit(tx, {
      actorId: actor.userId,
      action: "auth.password_changed",
      entityType: "user",
      entityId: actor.userId,
    });
  });
}
