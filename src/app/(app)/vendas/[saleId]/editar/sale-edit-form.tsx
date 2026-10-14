"use client";

import { RefreshCw, Trash2, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, FormAlert, Input, Select, SubmitButton } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { fieldErrorsOf, IDLE, type ActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { centsToInput, formatBRL, parseBRLToCents } from "@/lib/money";
import { previewTotalCents, SALE_CHANGED_CONCURRENTLY } from "@/lib/sales";
import type { PaymentMethod } from "@/server/db/schema";
import { updateSaleAction } from "../../actions";
import type { SaleEditCapabilities } from "../../policy";
import {
  CourseRows,
  formatPriceOnBlur,
  isValidPrice,
  OtherErrors,
  PaymentFields,
  TotalPreview,
  type CourseChoice,
  type CourseRow,
  type SellerChoice,
} from "../../sale-form-parts";

export type EditableSale = {
  id: string;
  version: number;
  saleDate: string;
  paymentMethod: PaymentMethod;
  installmentCount: number | null;
  sellerId: string;
  items: { id: string; courseName: string; institutionName: string; priceCents: number }[];
};

const INLINE_ERRORS = /^(sellerId|saleDate|paymentMethod|installmentCount|addItems\.\d+\.(courseId|priceCents))$/;

/**
 * Edição da venda. Só os campos permitidos ao perfil são renderizados (e,
 * portanto, enviados); o serviço revalida tudo. `expectedVersion` é a versão
 * lida na página: se outra operação alterou a venda, o serviço recusa e a
 * tela oferece recarregar (a página remonta o formulário com a nova versão);
 * nada é reenviado automaticamente com a versão antiga.
 */
export function SaleEditForm({
  sale,
  caps,
  courses,
  sellers,
}: {
  sale: EditableSale;
  caps: SaleEditCapabilities;
  courses: CourseChoice[];
  sellers: SellerChoice[];
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(updateSaleAction, IDLE);
  const [prices, setPrices] = useState<Record<string, string>>(() => Object.fromEntries(sale.items.map((i) => [i.id, centsToInput(i.priceCents)])));
  const [removed, setRemoved] = useState<string[]>([]);
  const [addRows, setAddRows] = useState<CourseRow[]>([]);
  const [method, setMethod] = useState<PaymentMethod | "">(sale.paymentMethod);
  const [installments, setInstallments] = useState(sale.installmentCount ? String(sale.installmentCount) : "");
  const [sellerId, setSellerId] = useState(sale.sellerId);
  const [saleDate, setSaleDate] = useState(sale.saleDate);
  const router = useRouter();
  const toast = useToast();
  const errors = fieldErrorsOf(state);
  // Depois do sucesso o botão continua travado até a navegação (sem segundo envio).
  const done = state.status === "success";
  const conflict = state.status === "error" && state.message === SALE_CHANGED_CONCURRENTLY;

  useEffect(() => {
    if (state.status !== "success") return;
    toast(state.message);
    router.push(state.redirectTo ?? `/vendas/${sale.id}`);
  }, [state, toast, router, sale.id]);

  const kept = sale.items.filter((i) => !removed.includes(i.id));
  const repriced = caps.financial ? kept.filter((i) => parseBRLToCents(prices[i.id]) !== i.priceCents) : [];
  const empty = kept.length + addRows.length === 0;
  const keptPrices = kept.map((i) => (caps.financial ? prices[i.id] : centsToInput(i.priceCents)));
  const total = empty ? null : previewTotalCents([...keptPrices, ...addRows.map((r) => r.price)]);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="saleId" value={sale.id} />
      <input type="hidden" name="expectedVersion" value={sale.version} />
      {removed.map((id) => (
        <input key={id} type="hidden" name="removeItemId" value={id} />
      ))}
      {repriced.map((i) => (
        <span key={i.id} hidden>
          <input type="hidden" name="repriceItemId" value={i.id} />
          <input type="hidden" name="repricePrice" value={prices[i.id]} />
        </span>
      ))}

      {conflict ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          <span>Esta venda mudou desde que você abriu esta tela e nada foi gravado agora. Atualize a venda para ver a versão atual e refaça a alteração.</span>
          <Button size="sm" variant="secondary" onClick={() => router.refresh()}>
            <RefreshCw className="size-4" aria-hidden />
            Recarregar venda
          </Button>
        </div>
      ) : (
        <FormAlert message={state.status === "error" ? state.message : undefined} />
      )}
      <OtherErrors errors={errors} shown={(key) => INLINE_ERRORS.test(key)} />

      <section aria-labelledby="edit-items" className="space-y-3">
        <h2 id="edit-items" className="text-sm font-semibold text-slate-900">
          Cursos da venda
        </h2>
        {!caps.financial && <p className="text-xs text-slate-500">Você pode incluir cursos. Remoção e correção de preço são feitas pelo supervisor.</p>}
        <ul className="space-y-2">
          {sale.items.map((item) => {
            const isRemoved = removed.includes(item.id);
            const priceId = `edit-price-${item.id}`;
            return (
              <li
                key={item.id}
                className={cn(
                  "grid gap-3 rounded-lg p-3 ring-1 sm:grid-cols-[1fr_10rem_auto] sm:items-center",
                  isRemoved ? "bg-red-50/60 ring-red-200" : "bg-white ring-slate-200",
                )}
              >
                <div className={cn("min-w-0", isRemoved && "line-through opacity-70")}>
                  <p className="truncate text-sm font-medium text-slate-900">{item.courseName}</p>
                  <p className="truncate text-xs text-slate-500">{item.institutionName}</p>
                </div>
                {caps.financial && !isRemoved ? (
                  <div>
                    <label htmlFor={priceId} className="sr-only">
                      Preço de {item.courseName} (R$)
                    </label>
                    <Input
                      id={priceId}
                      inputMode="decimal"
                      autoComplete="off"
                      value={prices[item.id]}
                      onChange={(e) => setPrices({ ...prices, [item.id]: e.target.value })}
                      onBlur={() => setPrices({ ...prices, [item.id]: formatPriceOnBlur(prices[item.id]) })}
                      aria-invalid={isValidPrice(prices[item.id]) ? undefined : true}
                    />
                    {parseBRLToCents(prices[item.id]) !== item.priceCents && (
                      <p className="mt-1 text-xs text-slate-500">Antes: {formatBRL(item.priceCents)}</p>
                    )}
                  </div>
                ) : (
                  <p className={cn("text-sm tabular-nums sm:text-right", isRemoved && "line-through opacity-70")}>{formatBRL(item.priceCents)}</p>
                )}
                {caps.financial && (
                  <div className="flex justify-end">
                    {isRemoved ? (
                      <Button variant="ghost" size="sm" onClick={() => setRemoved(removed.filter((id) => id !== item.id))}>
                        <Undo2 className="size-4" aria-hidden />
                        Desfazer
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setRemoved([...removed, item.id])} aria-label={`Remover ${item.courseName} da venda`}>
                        <Trash2 className="size-4" aria-hidden />
                        Remover
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <CourseRows
          rows={addRows}
          onChange={setAddRows}
          courses={courses}
          courseField="addCourseId"
          priceField="addPrice"
          errorKey="addItems"
          errors={errors}
          minRows={0}
          idPrefix="edit-add"
        />
        {empty ? (
          <p role="alert" className="text-sm font-medium text-red-600">
            A venda precisa de pelo menos um curso.
          </p>
        ) : (
          <TotalPreview totalCents={total} label="Novo total" />
        )}
      </section>

      {caps.financial && (
        <PaymentFields
          method={method}
          onMethodChange={setMethod}
          installments={installments}
          onInstallmentsChange={setInstallments}
          errors={errors}
          idPrefix="edit-sale"
          sendEmptyInstallments
        />
      )}

      {(caps.changeSeller || caps.setDate) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {caps.changeSeller && (
            <Field
              label="Vendedor responsável"
              htmlFor="edit-sale-seller"
              errors={errors.sellerId}
              hint="Ao trocar, a venda passa para a equipe atual do novo vendedor; se válida, o lead o acompanha."
            >
              <Select id="edit-sale-seller" name="sellerId" required value={sellerId} onChange={(e) => setSellerId(e.target.value)}>
                {!sellers.some((s) => s.id === sale.sellerId) && (
                  <option value={sale.sellerId} disabled>
                    Responsável atual (indisponível para escolha)
                  </option>
                )}
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.teamName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {caps.setDate && (
            <Field label="Data da venda" htmlFor="edit-sale-date" errors={errors.saleDate}>
              <Input id="edit-sale-date" name="saleDate" type="date" required value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
            </Field>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <ButtonLink href={`/vendas/${sale.id}`} variant="secondary">
          Cancelar
        </ButtonLink>
        <SubmitButton pending={pending || done}>Salvar alterações</SubmitButton>
      </div>
    </form>
  );
}
