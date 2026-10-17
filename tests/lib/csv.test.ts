import { describe, expect, it } from "vitest";
import { centsToCsv, toCsv } from "@/lib/csv";

describe("CSV para Excel", () => {
  it("BOM, separador ';', CRLF, aspas quando necessário e valores em centavos com vírgula", () => {
    const csv = toCsv(["Nome", "Valor"], [["Ana; Souza", { cents: 123_456 }], ['Diz "oi"', { cents: -5 }], [null, 7]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.slice(1).split("\r\n")).toEqual(["Nome;Valor", '"Ana; Souza";1234,56', '"Diz ""oi""";-0,05', ";7", ""]);
  });

  it("texto que o Excel leria como fórmula ganha apóstrofo; números não", () => {
    const csv = toCsv(["a"], [["=SOMA(A1)"], ["+55 79"], ["-x"], ["@cmd"], [{ cents: -100 }], [-3]]);
    expect(csv.slice(1).split("\r\n").slice(1, -1)).toEqual(["'=SOMA(A1)", "'+55 79", "'-x", "'@cmd", "-1,00", "-3"]);
  });

  it("centavos", () => {
    expect([0, 5, 100, 150_000, -1].map(centsToCsv)).toEqual(["0,00", "0,05", "1,00", "1500,00", "-0,01"]);
  });
});
