/**
 * Limitador de tentativas de login em memória (janela fixa).
 * Suficiente para uma única instância; com múltiplas instâncias, trocar por um
 * armazenamento compartilhado (tabela no Postgres ou Redis).
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const attempts = new Map<string, { count: number; resetAt: number }>();

export function isRateLimited(key: string, now = Date.now()): boolean {
  const entry = attempts.get(key);
  return !!entry && entry.resetAt > now && entry.count >= MAX_ATTEMPTS;
}

export function registerFailedAttempt(key: string, now = Date.now()): void {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}
