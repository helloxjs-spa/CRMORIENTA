/**
 * CSV para Excel (pt-BR), sem dependências: separador ";", decimal com
 * vírgula, UTF-8 com BOM (acentos corretos ao abrir no Excel) e quebras CRLF.
 *
 * Textos que começam com =, +, -, @, tabulação ou CR recebem um apóstrofo na
 * frente: o Excel não os interpreta como fórmula (injeção de fórmula em CSV).
 * Números e valores monetários não passam por essa proteção.
 */

export type CsvCell = string | number | null | undefined | { cents: number };

const FORMULA_START = /^[=+\-@\t\r]/;

function textCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Centavos → "1234,56" (sem separador de milhar, para o Excel ler como número). */
export function centsToCsv(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "object") return centsToCsv(value.cents);
  return textCell(value);
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return "﻿" + [header.map(textCell), ...rows.map((row) => row.map(cell))].map((line) => line.join(";")).join("\r\n") + "\r\n";
}
