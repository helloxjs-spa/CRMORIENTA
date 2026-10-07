/** Detecta violação de UNIQUE (SQLSTATE 23505), inclusive quando o Drizzle encapsula o erro do driver. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const pgError = e as { code?: string; constraint?: string; message?: string };
    if (pgError.code === "23505") {
      return !constraint || pgError.constraint === constraint || !!pgError.message?.includes(constraint);
    }
  }
  return false;
}
