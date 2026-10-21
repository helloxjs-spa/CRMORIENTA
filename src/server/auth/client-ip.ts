/**
 * IP do cliente para o limite de tentativas de login e para o registro em
 * sessões/auditoria.
 *
 * Na Cloudflare (Workers + OpenNext, que repassa os cabeçalhos sem reescrever),
 * `CF-Connecting-IP` é preenchido pela própria Cloudflare com o IP que se
 * conectou a ela. Já o primeiro valor de `X-Forwarded-For` é o que o cliente
 * enviou: a Cloudflare apenas acrescenta ao final. Por isso `CF-Connecting-IP`
 * é a única fonte confiável; sem ele, o IP fica desconhecido (null).
 * `X-Forwarded-For` e `X-Real-IP` só são lidos em desenvolvimento local e nos
 * testes (ver forwardedHeadersTrusted).
 */
export function clientIpFrom(headers: Pick<Headers, "get">, trustForwardedHeaders: boolean = forwardedHeadersTrusted()): string | null {
  const cloudflare = headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;
  if (!trustForwardedHeaders) return null;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return headers.get("x-real-ip")?.trim() || null;
}

/**
 * Cabeçalhos controlados pelo cliente só valem em `next dev`
 * (NODE_ENV=development) e nos testes (NODE_ENV=test). Qualquer outro valor,
 * inclusive ausente, os desliga: o Worker publicado e o `npm run cf:preview`
 * são builds de produção (o mesmo NODE_ENV que deixa o cookie de sessão
 * `Secure`, src/server/next/session.ts), assim como `next start`. É uma lista
 * de permissão: nada de inesperado habilita o fallback.
 */
export function forwardedHeadersTrusted(): boolean {
  const env = process.env.NODE_ENV;
  return env === "development" || env === "test";
}
