"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { MAX_INSTALLMENTS } from "@/lib/installments";
import { courseLabel } from "@/lib/leads";
import { centsToInput, formatBRL, parseBRLToCents } from "@/lib/money";
import { PAYMENT_METHOD_LABELS } from "@/lib/sales";
import type { PaymentMethod } from "@/server/db/schema";

export type CourseChoice = { id: string; name: string; institutionName: string };
export type SellerChoice = { id: string; name: string; teamName: string };
export type CourseRow = { key: number; courseId: string; price: string };

// Linhas iniciais usam chaves 0..n-1 (iguais no servidor e no cliente, sem
// divergência de hidratação); linhas adicionadas depois, só no cliente.
let nextRowKey = 1_000;
export const newCourseRow = (): CourseRow => ({ key: nextRowKey++, courseId: "", price: "" });

/** Preço válido e maior que zero? (para destacar o campo; o servidor valida de novo). */
export function isValidPrice(price: string): boolean {
  const cents = parseBRLToCents(price);
  return cents !== null && cents > 0;
}

/** Ao sair do campo, mostra o valor no padrão brasileiro (sem alterar o que é inválido). */
export function formatPriceOnBlur(price: string): string {
  const cents = parseBRLToCents(price);
  return cents !== null && cents > 0 ? centsToInput(cents) : price;
}

/**
 * Cursos repetíveis (o mesmo curso pode aparecer mais de uma vez), cada um
 * com o seu preço em reais. Os nomes dos campos são lidos pela action na
 * mesma ordem; o total não é enviado.
 */
export function CourseRows({
  rows,
  onChange,
  courses,
  courseField,
  priceField,
  errorKey,
  errors,
  minRows,
  idPrefix,
}: {
  rows: CourseRow[];
  onChange: (rows: CourseRow[]) => void;
  courses: CourseChoice[];
  courseField: string;
  priceField: string;
  /** Prefixo dos erros do servidor (ex.: "items" → items.0.priceCents). */
  errorKey: string;
  errors: Record<string, string[]>;
  minRows: number;
  idPrefix: string;
}) {
  const update = (key: number, patch: Partial<CourseRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-3">
      {rows.map((row, index) => {
        const courseErrors = errors[`${errorKey}.${index}.courseId`];
        const priceErrors = errors[`${errorKey}.${index}.priceCents`];
        const priceInvalid = !!priceErrors?.length || (row.price.trim() !== "" && !isValidPrice(row.price));
        return (
          <fieldset key={row.key} className="grid gap-3 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200 sm:grid-cols-[1fr_10rem_auto] sm:items-start">
            <legend className="sr-only">Curso {index + 1}</legend>
            <Field label={`Curso ${index + 1}`} htmlFor={`${idPrefix}-course-${row.key}`} errors={courseErrors}>
              <Select
                id={`${idPrefix}-course-${row.key}`}
                name={courseField}
                required
                value={row.courseId}
                onChange={(e) => update(row.key, { courseId: e.target.value })}
                aria-invalid={courseErrors?.length ? true : undefined}
              >
                <option value="" disabled>
                  Selecione o curso
                </option>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {courseLabel(course)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Preço (R$)" htmlFor={`${idPrefix}-price-${row.key}`} errors={priceErrors}>
              <Input
                id={`${idPrefix}-price-${row.key}`}
                name={priceField}
                required
                inputMode="decimal"
                autoComplete="off"
                placeholder="0,00"
                value={row.price}
                onChange={(e) => update(row.key, { price: e.target.value })}
                onBlur={() => update(row.key, { price: formatPriceOnBlur(row.price) })}
                aria-invalid={priceInvalid ? true : undefined}
              />
            </Field>
            <div className="flex items-end sm:pt-6">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                disabled={rows.length <= minRows}
                aria-label={`Retirar o curso ${index + 1} do formulário`}
              >
                <Trash2 className="size-4" aria-hidden />
                <span className="sm:sr-only">Retirar</span>
              </Button>
            </div>
          </fieldset>
        );
      })}
      <Button variant="secondary" size="sm" onClick={() => onChange([...rows, newCourseRow()])}>
        <Plus className="size-4" aria-hidden />
        Adicionar curso
      </Button>
    </div>
  );
}

/** Pix (à vista) ou Cartão com parcelas. Pix não envia parcelas. */
export function PaymentFields({
  method,
  onMethodChange,
  installments,
  onInstallmentsChange,
  errors,
  idPrefix,
  sendEmptyInstallments = false,
  maxInstallments = MAX_INSTALLMENTS,
}: {
  method: PaymentMethod | "";
  onMethodChange: (method: PaymentMethod) => void;
  installments: string;
  onInstallmentsChange: (value: string) => void;
  errors: Record<string, string[]>;
  idPrefix: string;
  /** Edição: ao trocar para Pix, envia parcelas vazias (= remover as parcelas do cartão). */
  sendEmptyInstallments?: boolean;
  /** Só conveniência (o servidor valida). Na edição, não menor que a quantidade atual. */
  maxInstallments?: number;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-slate-700">Forma de pagamento</legend>
        <div className="flex gap-2">
          {(["PIX", "CARD"] as const).map((value) => (
            <label
              key={value}
              className="flex h-10 flex-1 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm ring-1 ring-slate-300 has-checked:bg-brand-50 has-checked:ring-2 has-checked:ring-brand-600"
            >
              <input
                type="radio"
                name="paymentMethod"
                value={value}
                required
                checked={method === value}
                onChange={() => onMethodChange(value)}
                className="accent-brand-800"
              />
              {PAYMENT_METHOD_LABELS[value]}
            </label>
          ))}
        </div>
        {errors.paymentMethod?.map((e) => (
          <p key={e} className="text-xs font-medium text-red-600">
            {e}
          </p>
        ))}
      </fieldset>
      {method === "CARD" ? (
        <Field label="Parcelas" htmlFor={`${idPrefix}-installments`} errors={errors.installmentCount}>
          <Input
            id={`${idPrefix}-installments`}
            name="installmentCount"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxInstallments}
            step={1}
            required
            value={installments}
            onChange={(e) => onInstallmentsChange(e.target.value)}
            aria-invalid={errors.installmentCount?.length ? true : undefined}
          />
        </Field>
      ) : (
        sendEmptyInstallments && method === "PIX" && <input type="hidden" name="installmentCount" value="" />
      )}
    </div>
  );
}

export function TotalPreview({ totalCents, label = "Total da venda" }: { totalCents: number | null; label?: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-brand-50 px-4 py-3 ring-1 ring-brand-200" aria-live="polite">
      <span className="text-sm font-medium text-brand-900">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-brand-900">
        {totalCents === null ? <span className="text-sm font-normal">Preencha os preços</span> : formatBRL(totalCents)}
      </span>
    </div>
  );
}

/** Mensagens de erro do servidor que não têm campo próprio na tela. */
export function OtherErrors({ errors, shown }: { errors: Record<string, string[]>; shown: (key: string) => boolean }) {
  const messages = [...new Set(Object.entries(errors).flatMap(([key, list]) => (shown(key) ? [] : list)))];
  if (messages.length === 0) return null;
  return (
    <ul className="list-inside list-disc space-y-0.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200" role="alert">
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

export function useCourseRows(initial: number) {
  return useState<CourseRow[]>(() => Array.from({ length: initial }, (_, key) => ({ key, courseId: "", price: "" })));
}
