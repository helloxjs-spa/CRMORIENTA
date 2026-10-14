import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { ConflictError } from "@/server/errors";
import type { Database } from "./types";

/**
 * Transações de negócio: READ COMMITTED explícito (as operações críticas do
 * 003 recusam outro nível) e nova tentativa limitada quando o PostgreSQL
 * desfaz a transação por deadlock (40P01) ou falha de serialização (40001).
 *
 * A nova tentativa reexecuta o callback INTEIRO numa transação nova, depois
 * que o rollback da anterior terminou: nada da tentativa anterior sobrevive,
 * então não há duplicação de eventos ou auditoria. Por isso o callback só
 * pode ter efeitos dentro do banco (nada de e-mail, chamadas externas,
 * revalidatePath etc. dentro dele).
 */

export const RETRYABLE_SQLSTATES: readonly string[] = ["40P01", "40001"];
export const MAX_TRANSACTION_ATTEMPTS = 3;

/**
 * Sinal interno: dados lidos para decidir QUAIS linhas travar mudaram antes
 * das travas. A transação é desfeita e reiniciada como num deadlock.
 */
export class RetryTransactionError extends Error {
  constructor(message = "Dados usados para ordenar as travas mudaram; reiniciando a transação.") {
    super(message);
    this.name = "RetryTransactionError";
  }
}

/** Tentativas esgotadas: conflito recuperável, o usuário pode repetir a ação. */
export class TransactionConflictError extends ConflictError {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super("Estes dados foram alterados por outra operação ao mesmo tempo. Tente novamente.");
  }
}

/** Deadlock, serialização ou RetryTransactionError, inclusive encapsulados em `cause` (Drizzle/driver). */
export function isRetryableTransactionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current && typeof current === "object"; depth++) {
    if (current instanceof RetryTransactionError) return true;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_SQLSTATES.includes(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export type TransactionOptions = {
  /** Total de tentativas, incluindo a primeira. */
  maxAttempts?: number;
  /** Espera antes da tentativa `attempt + 1` (ms). */
  backoffMs?: (attempt: number) => number;
};

const defaultBackoff = (attempt: number) => attempt * 25 + Math.floor(Math.random() * 25);

export async function runTransaction<T>(
  db: Database,
  fn: (tx: Database) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  // Já dentro de uma transação: vira savepoint, sem retry nem nível próprio.
  // Um deadlock aborta a transação externa; quem a abriu decide repetir.
  if (is(db, PgTransaction)) return db.transaction(fn);

  const maxAttempts = options.maxAttempts ?? MAX_TRANSACTION_ATTEMPTS;
  const backoffMs = options.backoffMs ?? defaultBackoff;
  for (let attempt = 1; ; attempt++) {
    try {
      // O Drizzle só rejeita depois de concluir o ROLLBACK.
      return await db.transaction(fn, { isolationLevel: "read committed" });
    } catch (error) {
      if (!isRetryableTransactionError(error)) throw error;
      if (attempt >= maxAttempts) throw new TransactionConflictError(attempt, error);
      const wait = backoffMs(attempt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
