import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  clearSaleDraft,
  emptySaleDraftFields,
  newSaleDraft,
  readSaleDraft,
  restoreSaleDraftFields,
  SALE_DRAFT_TTL_MS,
  saleDraftKey,
  writeSaleDraft,
  type DraftStorage,
  type SaleDraft,
} from "@/lib/sale-draft";
import {
  REQUEST_ID_REUSED,
  SALE_CHANGED_CONCURRENTLY,
  SALE_CREATE_UNCERTAIN,
  saleStatusAlert,
  SALE_STATUS_UNCERTAIN,
} from "@/lib/sales";
import { settleAction } from "@/lib/settle-action";
import type { ActionState } from "@/lib/action-state";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const OTHER_ACTOR = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const OTHER_LEAD = "44444444-4444-4444-8444-444444444444";
const REQUEST = "55555555-5555-4555-8555-555555555555";
const COURSE = "66666666-6666-4666-8666-666666666666";
const NOW = Date.UTC(2026, 9, 14, 12);

/** sessionStorage em memória (o Vitest roda em Node). */
function memoryStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function filledDraft(overrides: Partial<SaleDraft> = {}): SaleDraft {
  return {
    ...newSaleDraft(ACTOR, LEAD, REQUEST, {
      items: [{ courseId: COURSE, price: "1.500,00" }],
      paymentMethod: "CARD",
      installmentCount: "6",
      sellerId: ACTOR,
      saleDate: "",
    }, NOW),
    ...overrides,
  };
}

describe("rascunho da venda (sessionStorage da aba)", () => {
  it("recarga recupera os dados e o MESMO requestId, inclusive tentativa já enviada", () => {
    const storage = memoryStorage();
    expect(writeSaleDraft(storage, filledDraft({ submitted: true }))).toBe(true);
    const restored = readSaleDraft(storage, ACTOR, LEAD, NOW + 60_000);
    expect(restored).toMatchObject({ requestId: REQUEST, submitted: true, createdAt: NOW });
    expect(restored?.fields.items).toEqual([{ courseId: COURSE, price: "1.500,00" }]);
  });

  it("vinculado ao usuário e ao lead: outra combinação não recupera nada", () => {
    const storage = memoryStorage();
    writeSaleDraft(storage, filledDraft());
    expect(readSaleDraft(storage, OTHER_ACTOR, LEAD, NOW)).toBeNull();
    expect(readSaleDraft(storage, ACTOR, OTHER_LEAD, NOW)).toBeNull();
    // Conteúdo adulterado com outro dono na chave deste usuário: descartado.
    storage.setItem(saleDraftKey(ACTOR, LEAD), JSON.stringify(filledDraft({ actorId: OTHER_ACTOR })));
    expect(readSaleDraft(storage, ACTOR, LEAD, NOW)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("expira em 24 h e descarta o vencido (sem reutilizar o requestId)", () => {
    const storage = memoryStorage();
    writeSaleDraft(storage, filledDraft());
    expect(readSaleDraft(storage, ACTOR, LEAD, NOW + SALE_DRAFT_TTL_MS - 1)).not.toBeNull();
    expect(readSaleDraft(storage, ACTOR, LEAD, NOW + SALE_DRAFT_TTL_MS)).toBeNull();
    expect(storage.data.size).toBe(0);
    // Data no futuro (relógio adulterado) também é inválida.
    writeSaleDraft(storage, filledDraft({ createdAt: NOW + 60_000 }));
    expect(readSaleDraft(storage, ACTOR, LEAD, NOW)).toBeNull();
  });

  it("dados inválidos ou corrompidos são descartados", () => {
    const storage = memoryStorage();
    const key = saleDraftKey(ACTOR, LEAD);
    for (const raw of [
      "{não é json",
      "null",
      JSON.stringify({ ...filledDraft(), requestId: "não-é-uuid" }),
      JSON.stringify({ ...filledDraft(), version: 2 }),
      JSON.stringify({ ...filledDraft(), fields: { ...filledDraft().fields, items: [] } }),
      JSON.stringify({ ...filledDraft(), fields: { ...filledDraft().fields, paymentMethod: "BOLETO" } }),
      JSON.stringify({ ...filledDraft(), submitted: "sim" }),
    ]) {
      storage.setItem(key, raw);
      expect(readSaleDraft(storage, ACTOR, LEAD, NOW)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
  });

  it("limpeza depois do sucesso remove só o rascunho deste usuário e lead", () => {
    const storage = memoryStorage();
    writeSaleDraft(storage, filledDraft());
    writeSaleDraft(storage, filledDraft({ leadId: OTHER_LEAD }));
    clearSaleDraft(storage, ACTOR, LEAD);
    expect(readSaleDraft(storage, ACTOR, LEAD, NOW)).toBeNull();
    expect(readSaleDraft(storage, ACTOR, OTHER_LEAD, NOW)).not.toBeNull();
  });

  it("armazenamento indisponível: gravar informa a falha e ler/limpar não quebram", () => {
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("cota");
      },
      removeItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(writeSaleDraft(broken, filledDraft())).toBe(false);
    expect(readSaleDraft(broken, ACTOR, LEAD, NOW)).toBeNull();
    expect(() => clearSaleDraft(broken, ACTOR, LEAD)).not.toThrow();
  });

  it("campos recuperados se ajustam às opções atuais da tela", () => {
    const fields = filledDraft({ fields: { ...filledDraft().fields, saleDate: "2026-01-02", sellerId: OTHER_ACTOR } }).fields;
    expect(restoreSaleDraftFields(fields, { courseIds: [], sellerIds: [ACTOR], defaultSellerId: ACTOR, canSetDate: false })).toEqual({
      items: [{ courseId: "", price: "1.500,00" }],
      paymentMethod: "CARD",
      installmentCount: "6",
      sellerId: ACTOR,
      saleDate: "",
    });
    expect(restoreSaleDraftFields(fields, { courseIds: [COURSE], sellerIds: [OTHER_ACTOR], defaultSellerId: ACTOR, canSetDate: true })).toMatchObject({
      items: [{ courseId: COURSE, price: "1.500,00" }],
      sellerId: OTHER_ACTOR,
      saleDate: "2026-01-02",
    });
    expect(emptySaleDraftFields(ACTOR).items).toHaveLength(1);
  });
});

describe("resultado incerto (resposta perdida)", () => {
  const prev: ActionState = { status: "idle" };

  it("falha de transporte vira erro 'incerto', sem afirmar sucesso nem falha", async () => {
    const lost = async (): Promise<ActionState> => {
      throw new TypeError("Failed to fetch");
    };
    expect(await settleAction(lost, prev, new FormData(), SALE_CREATE_UNCERTAIN)).toMatchObject({ status: "error", message: SALE_CREATE_UNCERTAIN });
  });

  it("resposta recebida passa sem alteração (sucesso e erro de negócio)", async () => {
    const ok: ActionState = { status: "success", message: "Venda registrada.", at: 1 };
    const reused: ActionState = { status: "error", message: REQUEST_ID_REUSED, fieldErrors: {}, at: 1 };
    expect(await settleAction(async () => ok, prev, new FormData(), SALE_CREATE_UNCERTAIN)).toBe(ok);
    expect(await settleAction(async () => reused, prev, new FormData(), SALE_CREATE_UNCERTAIN)).toBe(reused);
  });
});

describe("mensagens e avisos de conflito", () => {
  const error = (message: string): ActionState => ({ status: "error", message, fieldErrors: {}, at: 1 });

  it("estorno/reativação: conflito e resultado incerto pedem para atualizar a venda", () => {
    expect(saleStatusAlert(error(SALE_CHANGED_CONCURRENTLY))).toBe("conflict");
    expect(saleStatusAlert(error(SALE_STATUS_UNCERTAIN))).toBe("uncertain");
    expect(saleStatusAlert(error("Informe o motivo."))).toBeNull();
    expect(saleStatusAlert({ status: "success", message: "ok", at: 1 })).toBeNull();
  });

  it("textos neutros: sem atribuir a outra pessoa/operação e sem mandar gerar nova chave", () => {
    for (const message of [SALE_CHANGED_CONCURRENTLY, REQUEST_ID_REUSED, SALE_CREATE_UNCERTAIN, SALE_STATUS_UNCERTAIN]) {
      expect(message).not.toMatch(/outra pessoa|outro usuário|outra operação/i);
      expect(message).not.toMatch(/recarregue a página/i);
    }
    expect(REQUEST_ID_REUSED).toMatch(/nada foi gravado/);
    expect(REQUEST_ID_REUSED).not.toMatch(/registrada\./);
    expect(SALE_CHANGED_CONCURRENTLY).toMatch(/Atualize a venda/);
  });

  it("página inicial não lista vendas com múltiplos cursos como entrega futura", () => {
    const home = readFileSync("src/app/(app)/page.tsx", "utf8");
    expect(home).not.toMatch(/múltiplos cursos/);
  });
});
