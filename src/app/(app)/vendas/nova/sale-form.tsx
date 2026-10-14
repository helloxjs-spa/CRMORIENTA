"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, FormAlert, Input, Select, SubmitButton } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { fieldErrorsOf, IDLE, type ActionState } from "@/lib/action-state";
import {
  clearSaleDraft,
  emptySaleDraftFields,
  newSaleDraft,
  readSaleDraft,
  restoreSaleDraftFields,
  sessionDraftStorage,
  writeSaleDraft,
  type SaleDraft,
} from "@/lib/sale-draft";
import { previewTotalCents, REQUEST_ID_REUSED, SALE_CREATE_UNCERTAIN } from "@/lib/sales";
import { settleAction } from "@/lib/settle-action";
import type { PaymentMethod } from "@/server/db/schema";
import { createSaleAction } from "../actions";
import { CourseRows, OtherErrors, PaymentFields, TotalPreview, type CourseChoice, type CourseRow, type SellerChoice } from "../sale-form-parts";

const INLINE_ERRORS = /^(sellerId|saleDate|paymentMethod|installmentCount|items\.\d+\.(courseId|priceCents))$/;

type SaleFormProps = {
  requestId: string;
  actorId: string;
  leadId: string;
  courses: CourseChoice[];
  sellers: SellerChoice[];
  defaultSellerId: string;
  canSetDate: boolean;
};

const subscribeNothing = () => () => {};

/**
 * Registro de venda. `requestId` identifica a tentativa e vira o id da venda:
 * reenviar com o mesmo id nunca duplica (o servidor devolve a já gravada).
 * O rascunho (dados + requestId) fica no sessionStorage desta aba, ligado ao
 * usuário e ao lead, e sobrevive a um F5. Um novo id só nasce quando o
 * usuário escolhe "Começar nova venda". O total é só exibido: o servidor soma.
 *
 * O formulário só é montado no navegador (o rascunho não existe no servidor):
 * assim nada é enviado com o id do servidor antes de o rascunho ser lido.
 */
export function SaleForm(props: SaleFormProps) {
  const isClient = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const [generation, setGeneration] = useState(0);
  if (!isClient) return <p className="text-sm text-slate-500">Carregando formulário…</p>;
  return <DraftedSaleForm key={generation} {...props} fresh={generation > 0} onStartNew={() => setGeneration((g) => g + 1)} />;
}

type Boot = { draft: SaleDraft; restored: boolean; saved: boolean };

function bootDraft({ requestId, actorId, leadId, courses, sellers, defaultSellerId, canSetDate, fresh }: SaleFormProps & { fresh: boolean }): Boot {
  const storage = sessionDraftStorage();
  const stored = storage && !fresh ? readSaleDraft(storage, actorId, leadId) : null;
  const draft = stored
    ? {
        ...stored,
        fields: restoreSaleDraftFields(stored.fields, {
          courseIds: courses.map((c) => c.id),
          sellerIds: sellers.map((s) => s.id),
          defaultSellerId,
          canSetDate,
        }),
      }
    : newSaleDraft(actorId, leadId, fresh ? crypto.randomUUID() : requestId, emptySaleDraftFields(defaultSellerId));
  return { draft, restored: !!stored, saved: !!storage && writeSaleDraft(storage, draft) };
}

function DraftedSaleForm(props: SaleFormProps & { fresh: boolean; onStartNew: () => void }) {
  const { actorId, leadId, courses, sellers, canSetDate, onStartNew } = props;
  const [boot] = useState(() => bootDraft(props));
  const { requestId, createdAt, fields } = boot.draft;
  const [rows, setRows] = useState<CourseRow[]>(() => fields.items.map((item, key) => ({ key, ...item })));
  const [method, setMethod] = useState<PaymentMethod | "">(fields.paymentMethod);
  const [installments, setInstallments] = useState(fields.installmentCount);
  // Controlados: o React limpa campos não controlados a cada envio do form.
  const [sellerId, setSellerId] = useState(fields.sellerId);
  const [saleDate, setSaleDate] = useState(fields.saleDate);
  // Já houve envio desta tentativa sem confirmação de sucesso.
  const [submitted, setSubmitted] = useState(boot.draft.submitted);
  // O rascunho está guardado nesta aba? (falso: armazenamento indisponível)
  const [saved, setSaved] = useState(boot.saved);
  const [confirmingNew, setConfirmingNew] = useState(false);

  const draftOf = (wasSubmitted: boolean): SaleDraft => ({
    version: 1,
    actorId,
    leadId,
    requestId,
    createdAt,
    submitted: wasSubmitted,
    fields: { items: rows.map(({ courseId, price }) => ({ courseId, price })), paymentMethod: method, installmentCount: installments, sellerId, saleDate },
  });

  const [state, formAction, pending] = useActionState<ActionState, FormData>(async (prev, formData) => {
    // Antes de enviar: a tentativa fica marcada como enviada (sobrevive a um F5).
    const storage = sessionDraftStorage();
    setSubmitted(true);
    setSaved(!!storage && writeSaleDraft(storage, draftOf(true)));
    const result = await settleAction(createSaleAction, prev, formData, SALE_CREATE_UNCERTAIN);
    // Só o sucesso confirmado encerra a tentativa. Erro, conflito ou resposta
    // perdida mantêm o mesmo requestId para um reenvio seguro.
    if (result.status === "success" && storage) clearSaleDraft(storage, actorId, leadId);
    return result;
  }, IDLE);
  const router = useRouter();
  const toast = useToast();
  const errors = fieldErrorsOf(state);
  // Depois do sucesso o botão continua travado até a navegação (sem segundo envio).
  const done = state.status === "success";
  const reused = state.status === "error" && state.message === REQUEST_ID_REUSED;
  const uncertain = state.status === "error" && state.message === SALE_CREATE_UNCERTAIN;

  // Mantém o rascunho atualizado a cada alteração (falha aqui é silenciosa;
  // o envio grava de novo e mostra o aviso se não conseguir).
  const serialized = JSON.stringify(draftOf(submitted));
  useEffect(() => {
    const storage = sessionDraftStorage();
    if (storage && !done) writeSaleDraft(storage, JSON.parse(serialized) as SaleDraft);
  }, [serialized, done]);

  useEffect(() => {
    if (state.status !== "success") return;
    toast(state.message);
    router.push(state.redirectTo ?? "/vendas");
  }, [state, toast, router]);

  const startNew = () => {
    const storage = sessionDraftStorage();
    if (storage) clearSaleDraft(storage, actorId, leadId);
    onStartNew();
  };

  const total = previewTotalCents(rows.map((r) => r.price));
  const leadHref = `/leads?lead=${leadId}`;

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="leadId" value={leadId} />

      {!saved && (
        <Notice>
          Não foi possível guardar o rascunho neste navegador. Se a página for recarregada, os dados digitados e a identificação desta tentativa se
          perdem: nesse caso, confira as vendas do lead antes de registrar de novo.
        </Notice>
      )}
      {boot.restored && state.status === "idle" && (
        <Notice>
          {boot.draft.submitted
            ? "Esta aba tem uma tentativa de registro desta venda já enviada, sem confirmação do resultado. Os dados e a identificação da tentativa foram mantidos: enviar de novo sem alterar nada não duplica a venda. Se for alterar os dados, confira antes as vendas do lead."
            : "Rascunho desta venda recuperado nesta aba."}
        </Notice>
      )}
      {reused || uncertain ? <Notice role="alert">{state.message}</Notice> : <FormAlert message={state.status === "error" ? state.message : undefined} />}
      <OtherErrors errors={errors} shown={(key) => INLINE_ERRORS.test(key)} />

      {(boot.restored || submitted) && !done && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink href={leadHref} variant="secondary" size="sm">
              Conferir vendas do lead
            </ButtonLink>
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => (submitted ? setConfirmingNew(true) : startNew())}>
              <RotateCcw className="size-4" aria-hidden />
              Começar nova venda
            </Button>
          </div>
          {confirmingNew && (
            <Notice role="alert">
              <p>
                Pode já existir uma venda registrada por esta tentativa. Confira as vendas do lead antes. Começar uma nova venda descarta este rascunho e
                cria outra tentativa, que será gravada como uma venda separada.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="danger" size="sm" onClick={startNew}>
                  Descartar e começar nova venda
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmingNew(false)}>
                  Cancelar
                </Button>
              </div>
            </Notice>
          )}
        </div>
      )}

      <section aria-labelledby="sale-courses" className="space-y-3">
        <h2 id="sale-courses" className="text-sm font-semibold text-slate-900">
          Cursos vendidos
        </h2>
        <CourseRows
          rows={rows}
          onChange={setRows}
          courses={courses}
          courseField="itemCourseId"
          priceField="itemPrice"
          errorKey="items"
          errors={errors}
          minRows={1}
          idPrefix="new-sale"
        />
        <TotalPreview totalCents={total} />
      </section>

      <PaymentFields
        method={method}
        onMethodChange={setMethod}
        installments={installments}
        onInstallmentsChange={setInstallments}
        errors={errors}
        idPrefix="new-sale"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vendedor responsável" htmlFor="new-sale-seller" errors={errors.sellerId}>
          <Select id="new-sale-seller" name="sellerId" required value={sellerId} onChange={(e) => setSellerId(e.target.value)}>
            <option value="" disabled>
              Selecione o vendedor
            </option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.teamName}
              </option>
            ))}
          </Select>
        </Field>
        {canSetDate && (
          <Field label="Data da venda" htmlFor="new-sale-date" errors={errors.saleDate} hint="Em branco: hoje.">
            <Input id="new-sale-date" name="saleDate" type="date" value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
          </Field>
        )}
      </div>

      <div className="flex justify-end">
        <SubmitButton pending={pending || done}>Registrar venda</SubmitButton>
      </div>
    </form>
  );
}

function Notice({ children, role = "status" }: { children: ReactNode; role?: "status" | "alert" }) {
  return (
    <div role={role} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
      {children}
    </div>
  );
}
