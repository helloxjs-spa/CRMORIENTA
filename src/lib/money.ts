/** Valores monetários trafegam e são armazenados em centavos (inteiros). */

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatBRL(cents: number): string {
  return brl.format(cents / 100);
}

/** Centavos → texto editável no padrão brasileiro, sem símbolo (ex.: 123456 → "1.234,56"). */
export function centsToInput(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/**
 * Converte um valor digitado em reais para centavos, sem passar por ponto
 * flutuante. Aceita "1.234,56", "1234,56", "R$ 300", "300" e "1234.56".
 * Retorna null se o texto não for um valor válido com até 2 casas decimais.
 */
export function parseBRLToCents(input: string): number | null {
  let value = input.replace(/R\$/i, "").replace(/\s/g, "");
  if (!value || value.startsWith("-")) return null;

  if (value.includes(",")) {
    // Padrão brasileiro: "." separa milhares, "," separa decimais.
    if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(value)) return null;
    value = value.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(value)) {
    // "1.234" ou "1.234.567" sem vírgula: pontos são separadores de milhar.
    value = value.replace(/\./g, "");
  } else if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    return null;
  }

  const [reais, centavos = ""] = value.split(".");
  const cents = Number(reais) * 100 + Number(centavos.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
