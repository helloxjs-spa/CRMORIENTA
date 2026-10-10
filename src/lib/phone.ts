/**
 * Telefone brasileiro do lead (identidade única no CRM).
 *
 * Formato canônico armazenado: só dígitos, 55 + DDD + número.
 *   celular: 9 dígitos começando em 9   -> "5579999999999"
 *   fixo:    8 dígitos começando em 2-5 -> "557932110000"
 * O banco confere o mesmo formato (CHECK leads_phone_canonical, migration 002);
 * um teste garante que a lista de DDDs abaixo é a mesma do banco.
 */

/** DDDs válidos no Brasil (Anatel). */
export const BRAZILIAN_DDDS = [
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
] as const;

const DDD_SET = new Set<number>(BRAZILIAN_DDDS);

export type PhoneParseResult = { ok: true; phone: string } | { ok: false; error: string };

/**
 * Converte o que foi digitado para o formato canônico. Aceita, por exemplo:
 * "(79) 99999-9999", "79 99999-9999", "+55 79 99999-9999", "079 99999-9999".
 */
export function parseBrazilianPhone(input: string): PhoneParseResult {
  if (/[^\d\s()+.\-]/.test(input)) return { ok: false, error: "Use apenas números (com DDD)." };
  let digits = input.replace(/\D/g, "");
  if (digits.length === 0) return { ok: false, error: "Informe o telefone com DDD." };

  // Prefixo de operadora/discagem nacional ("0 79 ...") ou código do país.
  if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");
  else if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) digits = digits.slice(2);

  if (digits.length < 10) return { ok: false, error: "Telefone incompleto. Informe o DDD e o número." };
  if (digits.length > 11) return { ok: false, error: "Telefone com dígitos a mais." };

  const ddd = Number(digits.slice(0, 2));
  const number = digits.slice(2);
  if (!DDD_SET.has(ddd)) return { ok: false, error: "DDD inválido." };

  if (number.length === 9) {
    if (!number.startsWith("9")) return { ok: false, error: "Celular com 9 dígitos deve começar com 9." };
  } else if (/^[6-9]/.test(number)) {
    return { ok: false, error: "Celular deve ter o 9º dígito (ex.: (79) 99999-9999)." };
  } else if (!/^[2-5]/.test(number)) {
    return { ok: false, error: "Telefone fixo inválido." };
  }

  return { ok: true, phone: `55${digits}` };
}

/** "5579999999999" -> "(79) 99999-9999"; "557932110000" -> "(79) 3211-0000". */
export function formatPhone(canonical: string): string {
  const national = canonical.startsWith("55") ? canonical.slice(2) : canonical;
  const ddd = national.slice(0, 2);
  const number = national.slice(2);
  const split = number.length - 4;
  return `(${ddd}) ${number.slice(0, split)}-${number.slice(split)}`;
}

/** Dígitos de um termo de busca, sem o código do país, para buscar por trecho do telefone. */
export function phoneSearchDigits(term: string): string {
  return term.replace(/\D/g, "");
}
