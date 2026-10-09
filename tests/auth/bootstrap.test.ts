import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login } from "@/server/auth/auth.service";
import { BOOTSTRAP_DONE_MESSAGE, EMAIL_TAKEN_MESSAGE, bootstrapFirstAdmin } from "@/server/auth/bootstrap";
import { verifyPassword } from "@/server/auth/password";
import { getActorBySessionToken } from "@/server/auth/session";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents, users } from "@/server/db/schema";
import { ConflictError, ValidationError } from "@/server/errors";
import { createTestDatabase, insertUser } from "../support/db";

const PASSWORD = "Primeira-Senha-Forte-2026";

describe("bootstrap do primeiro ADMIN (npm run admin:create)", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });
  afterAll(() => handle.close());

  it("faz rollback completo se uma parte da transação falhar (usuário não fica sem auditoria)", async () => {
    // Simula falha na gravação da auditoria, depois do INSERT do usuário.
    await handle.db.execute(sql`
      CREATE FUNCTION test_fail_bootstrap_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falha simulada na auditoria'; END; $$
    `);
    await handle.db.execute(sql`
      CREATE TRIGGER test_fail_bootstrap_audit BEFORE INSERT ON audit_events
        FOR EACH ROW WHEN (NEW.action = 'auth.admin_bootstrapped') EXECUTE FUNCTION test_fail_bootstrap_audit()
    `);
    try {
      const error = await bootstrapFirstAdmin(handle.db, { name: "Dona do Polo", email: "dona@polo.com", password: PASSWORD }).catch(
        (e: unknown) => e,
      );
      expect((error as { cause?: Error }).cause?.message).toContain("falha simulada");
      // O INSERT do usuário aconteceu antes da falha e foi desfeito junto.
      expect(await handle.db.select().from(users)).toHaveLength(0);
      expect(await handle.db.select().from(auditEvents)).toHaveLength(0);
    } finally {
      await handle.db.execute(sql`DROP TRIGGER test_fail_bootstrap_audit ON audit_events`);
      await handle.db.execute(sql`DROP FUNCTION test_fail_bootstrap_audit()`);
    }
  });

  it("valida a entrada com as mesmas regras da aplicação e não grava nada se inválida", async () => {
    for (const input of [
      { name: "Dona do Polo", email: "não-é-email", password: PASSWORD },
      { name: "Dona do Polo", email: "dona@polo.com", password: "curta" },
      { name: "D", email: "dona@polo.com", password: PASSWORD },
      { name: "Dona do Polo", email: "dona@polo.com", password: PASSWORD, role: "SELLER" },
    ]) {
      await expect(bootstrapFirstAdmin(handle.db, input)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await handle.db.select().from(users)).toHaveLength(0);
  });

  it("cria o primeiro ADMIN ativo, sem equipe, com e-mail normalizado", async () => {
    const created = await bootstrapFirstAdmin(handle.db, { name: "  Dona do Polo ", email: "  Dona@Polo.COM ", password: PASSWORD });
    expect(created).toMatchObject({ name: "Dona do Polo", email: "dona@polo.com" });

    const [row] = await handle.db.select().from(users).where(eq(users.id, created.id));
    expect(row).toMatchObject({ role: "ADMIN", teamId: null, active: true, email: "dona@polo.com" });
  });

  it("guarda a senha só como hash scrypt (nunca em texto puro), verificável pelo mesmo algoritmo do login", async () => {
    const [row] = await handle.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.email, "dona@polo.com"));
    expect(row.passwordHash).not.toBe(PASSWORD);
    expect(row.passwordHash).not.toContain(PASSWORD);
    expect(row.passwordHash).toMatch(/^scrypt\$/);
    expect(await verifyPassword(PASSWORD, row.passwordHash)).toBe(true);
  });

  it("o login funciona com a senha informada e resolve um ator ADMIN", async () => {
    const { token } = await login(handle.db, { email: "DONA@polo.com", password: PASSWORD });
    expect(await getActorBySessionToken(handle.db, token)).toMatchObject({ role: "ADMIN", teamId: null, supervisedTeamId: null });
  });

  it("registra o evento de auditoria sem ator e sem dados sensíveis", async () => {
    const events = await handle.db.select().from(auditEvents).where(eq(auditEvents.action, "auth.admin_bootstrapped"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: null, entityType: "user", teamId: null });
    expect(events[0].metadata).toEqual({ source: "admin:create", role: "ADMIN" });
    expect(JSON.stringify(events[0])).not.toMatch(new RegExp(`${PASSWORD}|scrypt`));
  });

  it("recusa quando já existe ADMIN (mesmo com outro e-mail)", async () => {
    const error = await bootstrapFirstAdmin(handle.db, { name: "Outro Admin", email: "outro@polo.com", password: PASSWORD }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe(BOOTSTRAP_DONE_MESSAGE);
    expect(await handle.db.select().from(users).where(eq(users.role, "ADMIN"))).toHaveLength(1);
  });
});

describe("bootstrap com e-mail já existente", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
    // Banco sem ADMIN, mas com um usuário que já usa o e-mail.
    await insertUser(handle, { name: "Supervisora", role: "SUPERVISOR", email: "dona@polo.com" });
  });
  afterAll(() => handle.close());

  it("recusa e não cria nenhum ADMIN", async () => {
    const error = await bootstrapFirstAdmin(handle.db, { name: "Dona do Polo", email: "DONA@polo.com", password: PASSWORD }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe(EMAIL_TAKEN_MESSAGE);
    expect(await handle.db.select().from(users).where(eq(users.role, "ADMIN"))).toHaveLength(0);
    expect(await handle.db.select().from(auditEvents)).toHaveLength(0);
  });
});

describe("bootstraps simultâneos", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });
  afterAll(() => handle.close());

  it("apenas um ADMIN é criado", async () => {
    const results = await Promise.allSettled([
      bootstrapFirstAdmin(handle.db, { name: "Admin Um", email: "um@polo.com", password: PASSWORD }),
      bootstrapFirstAdmin(handle.db, { name: "Admin Dois", email: "dois@polo.com", password: PASSWORD }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await handle.db.select().from(users).where(eq(users.role, "ADMIN"))).toHaveLength(1);
  });
});
