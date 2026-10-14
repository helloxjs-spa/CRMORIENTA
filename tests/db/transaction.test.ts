import { like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents } from "@/server/db/schema";
import {
  isRetryableTransactionError,
  MAX_TRANSACTION_ATTEMPTS,
  RetryTransactionError,
  runTransaction,
  TransactionConflictError,
} from "@/server/db/transaction";
import type { Database } from "@/server/db/types";
import { ConflictError, ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { createTestDatabase, seedOrganization } from "../support/db";

let handle: DatabaseHandle;
let admin: string;
let seq = 0;

beforeAll(async () => {
  handle = await createTestDatabase();
  admin = (await seedOrganization(handle)).ids.admin;
});
afterAll(() => handle.close());

const noWait = { backoffMs: () => 0 };
const pgError = (code: string) => Object.assign(new Error(`erro ${code}`), { code });

/** Grava uma auditoria marcada (para provar o rollback) e devolve a marca. */
async function audit(tx: Database, tag: string): Promise<void> {
  await recordAudit(tx, { actorId: admin, action: "user.updated", entityType: "user", entityId: tag });
}

async function audited(prefix: string): Promise<string[]> {
  const rows = await handle.db.select({ entityId: auditEvents.entityId }).from(auditEvents).where(like(auditEvents.entityId, `${prefix}%`));
  return rows.map((r) => r.entityId!).sort();
}

describe("isRetryableTransactionError", () => {
  it("reconhece 40P01 e 40001, inclusive dentro de cause", () => {
    expect(isRetryableTransactionError(pgError("40P01"))).toBe(true);
    expect(isRetryableTransactionError(pgError("40001"))).toBe(true);
    expect(isRetryableTransactionError(new Error("drizzle", { cause: new Error("driver", { cause: pgError("40001") }) }))).toBe(true);
    expect(isRetryableTransactionError(new RetryTransactionError())).toBe(true);
  });

  it("não repete outros erros", () => {
    for (const error of [pgError("23505"), pgError("P0001"), pgError("40P0"), new ValidationError("x"), new Error("x"), null, "40P01"]) {
      expect(isRetryableTransactionError(error)).toBe(false);
    }
  });
});

describe("runTransaction", () => {
  it("roda em READ COMMITTED", async () => {
    const level = await runTransaction(handle.db, async (tx) => {
      const result = (await tx.execute(sql`select current_setting('transaction_isolation') as level`)) as unknown as {
        rows: { level: string }[];
      };
      return result.rows[0].level;
    });
    expect(level).toBe("read committed");
  });

  it.each([
    ["40P01 direto", () => pgError("40P01")],
    ["40001 em cause", () => new Error("encapsulado", { cause: pgError("40001") })],
    ["RetryTransactionError", () => new RetryTransactionError()],
  ])("%s: desfaz a tentativa, refaz o callback inteiro e grava uma vez só", async (_name, makeError) => {
    const tag = `retry-${++seq}-`;
    let attempts = 0;
    const result = await runTransaction(
      handle.db,
      async (tx) => {
        attempts++;
        await audit(tx, `${tag}${attempts}`);
        if (attempts === 1) throw makeError();
        return "concluído";
      },
      noWait,
    );
    expect(result).toBe("concluído");
    expect(attempts).toBe(2);
    expect(await audited(tag)).toEqual([`${tag}2`]);
  });

  it("erro real do servidor (SQLSTATE 40P01 encapsulado pelo Drizzle) também é refeito", async () => {
    const tag = `server-${++seq}-`;
    let attempts = 0;
    await runTransaction(
      handle.db,
      async (tx) => {
        attempts++;
        await audit(tx, `${tag}${attempts}`);
        if (attempts === 1) await tx.execute(sql.raw(`DO $$ BEGIN RAISE EXCEPTION 'simulado' USING ERRCODE = '40P01'; END $$`));
      },
      noWait,
    );
    expect(attempts).toBe(2);
    expect(await audited(tag)).toEqual([`${tag}2`]);
  });

  it("esgota as tentativas: conflito recuperável, nada gravado", async () => {
    const tag = `exhaust-${++seq}-`;
    let attempts = 0;
    const error = await runTransaction(
      handle.db,
      async (tx) => {
        attempts++;
        await audit(tx, `${tag}${attempts}`);
        throw pgError("40P01");
      },
      noWait,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionConflictError);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as TransactionConflictError).attempts).toBe(MAX_TRANSACTION_ATTEMPTS);
    expect(attempts).toBe(MAX_TRANSACTION_ATTEMPTS);
    expect(await audited(tag)).toEqual([]);
  });

  it("respeita maxAttempts", async () => {
    let attempts = 0;
    await expect(
      runTransaction(
        handle.db,
        async () => {
          attempts++;
          throw pgError("40001");
        },
        { maxAttempts: 5, backoffMs: () => 0 },
      ),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(attempts).toBe(5);
  });

  it.each([
    ["erro de negócio", () => new ValidationError("inválido")],
    ["violação de unicidade (23505)", () => pgError("23505")],
    ["erro de trigger (P0001)", () => pgError("P0001")],
  ])("%s: não repete, devolve o erro original e desfaz tudo", async (_name, makeError) => {
    const tag = `noretry-${++seq}-`;
    const original = makeError();
    let attempts = 0;
    const error = await runTransaction(
      handle.db,
      async (tx) => {
        attempts++;
        await audit(tx, `${tag}${attempts}`);
        throw original;
      },
      noWait,
    ).catch((e: unknown) => e);
    expect(error).toBe(original);
    expect(attempts).toBe(1);
    expect(await audited(tag)).toEqual([]);
  });

  it("dentro de outra transação vira savepoint e não repete (quem abriu a externa decide)", async () => {
    const tag = `nested-${++seq}-`;
    let attempts = 0;
    const error = await handle.db
      .transaction(async (outer) => {
        await audit(outer, `${tag}outer`);
        await runTransaction(
          outer,
          async (tx) => {
            attempts++;
            await audit(tx, `${tag}inner`);
            throw pgError("40P01");
          },
          noWait,
        );
      })
      .catch((e: unknown) => e);
    expect(isRetryableTransactionError(error)).toBe(true);
    expect(attempts).toBe(1);
    expect(await audited(tag)).toEqual([]);
  });
});
