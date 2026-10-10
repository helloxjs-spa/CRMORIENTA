import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "@/server/context";
import type { DatabaseHandle } from "@/server/db/connect";
import { leadEvents, leads } from "@/server/db/schema";
import { AWAITING_SUPERVISOR_MESSAGE, createLead, trashLead } from "@/server/modules/leads/leads.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourse, setLeadStage } from "../support/leads";

/**
 * Server Actions de Leads chamadas diretamente (como um POST forjado faria),
 * sem passar pela tela. Só a leitura do cookie é substituída: action →
 * runAction → serviço → banco rodam de verdade.
 */
const session = vi.hoisted(() => ({ current: null as ServiceContext | null }));
vi.mock("@/server/next/session", () => ({
  requireServiceContext: async () => {
    if (!session.current) throw new Error("sem sessão no teste");
    return session.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const actions = await import("@/app/(app)/leads/actions");

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let courseId: string;
let leadOfA1: string;
let leadOfB1: string;

const IDLE = { status: "idle" } as const;
const FORBIDDEN = "Você não tem permissão para executar esta ação.";
const NOT_FOUND = "Registro não encontrado.";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function as(userId: string) {
  session.current = await org.ctx(userId);
}

const row = async (id: string) => (await handle.db.select().from(leads).where(eq(leads.id, id)))[0];

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  courseId = await insertCourse(handle);
  leadOfA1 = (await createLead(await org.ctx(org.ids.sellerA1), { name: "Lead do A1", phone: "79 98000-0001", interestCourseId: courseId })).id;
  leadOfB1 = (await createLead(await org.ctx(org.ids.sellerB1), { name: "Lead do B1", phone: "79 98000-0002", interestCourseId: courseId })).id;
});
afterAll(() => handle.close());

describe("cadastro e edição pela action", () => {
  it("cadastra na carteira de quem está logado, ignorando campos forjados no formulário", async () => {
    await as(org.ids.sellerA2);
    const result = await actions.createLeadAction(
      IDLE,
      form({ name: "Novo Lead", phone: "+55 79 98000-0003", interestCourseId: courseId, ownerId: org.ids.sellerB1, teamId: org.ids.teamB, stage: "NEGOTIATION" }),
    );
    expect(result).toMatchObject({ status: "success", message: "Lead cadastrado." });
    const [created] = await handle.db.select().from(leads).where(eq(leads.phone, "5579980000003"));
    expect(created).toMatchObject({ ownerId: org.ids.sellerA2, teamId: org.ids.teamA, stage: "NEW" });
  });

  it("telefone duplicado ativo volta como erro de negócio com responsável e equipe (não erro genérico)", async () => {
    await as(org.ids.sellerB1);
    const result = await actions.createLeadAction(IDLE, form({ name: "Repetido", phone: "(79) 98000-0001", interestCourseId: courseId }));
    expect(result).toEqual({
      status: "error",
      message: "Este lead já está cadastrado. Responsável: Vendedor A1 (equipe Equipe A).",
      fieldErrors: {},
      at: expect.any(Number),
    });
  });

  it("telefone de lead na Lixeira volta com a mensagem da Lixeira", async () => {
    const trashed = await createLead(await org.ctx(org.ids.sellerA1), { name: "Descartado", phone: "79 98000-0004", interestCourseId: courseId });
    await trashLead(await org.ctx(org.ids.supA), trashed.id);
    await as(org.ids.sellerB1);
    const result = await actions.createLeadAction(IDLE, form({ name: "Tentativa", phone: "79980000004", interestCourseId: courseId }));
    expect(result).toMatchObject({
      status: "error",
      message: "Este lead já está cadastrado e encontra-se na Lixeira. Solicite ao supervisor ou administrador a recuperação.",
    });
  });

  it("erros de validação voltam por campo", async () => {
    await as(org.ids.sellerA1);
    const result = await actions.createLeadAction(IDLE, form({ name: "X", phone: "(79) 9800-0005", interestCourseId: "" }));
    expect(result.status).toBe("error");
    expect(Object.keys(result.status === "error" ? result.fieldErrors : {}).sort()).toEqual(["interestCourseId", "name", "phone"]);
  });

  it("edição com telefone de outro lead volta a mensagem de duplicidade da edição e não altera nada", async () => {
    await as(org.ids.sellerA1);
    const before = await row(leadOfA1);
    const result = await actions.editLeadAction(
      IDLE,
      form({ leadId: leadOfA1, name: "Outro Nome", phone: "79 98000-0002", interestCourseId: courseId }),
    );
    expect(result).toMatchObject({
      status: "error",
      message: "Este telefone já pertence a outro lead. Responsável: Vendedor B1 (equipe Equipe B).",
    });
    expect(await row(leadOfA1)).toEqual(before);
  });

  it("edição bem-sucedida pelo vendedor responsável", async () => {
    await as(org.ids.sellerA1);
    const result = await actions.editLeadAction(
      IDLE,
      form({ leadId: leadOfA1, name: "Lead do A1 Corrigido", phone: "(79) 98000-0001", interestCourseId: courseId }),
    );
    expect(result).toMatchObject({ status: "success" });
    expect((await row(leadOfA1)).name).toBe("Lead do A1 Corrigido");
  });
});

describe("vendedor chamando actions administrativas diretamente", () => {
  it("recebe erro de permissão e nada muda", async () => {
    await as(org.ids.sellerA1);
    const before = await row(leadOfA1);
    const results = [
      await actions.transferLeadAction(IDLE, form({ leadId: leadOfA1, toSellerId: org.ids.sellerA2 })),
      await actions.redistributeLeadAction(IDLE, form({ leadId: leadOfA1, toSellerId: org.ids.sellerA2 })),
      await actions.trashLeadAction(IDLE, form({ leadId: leadOfA1 })),
      await actions.restoreLeadAction(IDLE, form({ leadId: leadOfA1, toSellerId: org.ids.sellerA1 })),
    ];
    for (const result of results) expect(result).toMatchObject({ status: "error", message: FORBIDDEN });
    expect(await row(leadOfA1)).toEqual(before);
  });

  it("não edita nem anota lead de outro vendedor (404, sem revelar o lead)", async () => {
    await as(org.ids.sellerA1);
    const edit = await actions.editLeadAction(IDLE, form({ leadId: leadOfB1, name: "Invadido", phone: "79 98000-0002", interestCourseId: courseId }));
    const note = await actions.addLeadNoteAction(IDLE, form({ leadId: leadOfB1, body: "Invasão" }));
    for (const result of [edit, note]) {
      expect(result).toMatchObject({ status: "error", message: NOT_FOUND });
      expect(JSON.stringify(result)).not.toMatch(/Lead do B1|Vendedor B1|Equipe B/);
    }
    expect((await row(leadOfB1)).name).toBe("Lead do B1");
  });

  it("Follow-up 3 vencido: somente leitura para o vendedor (sem atualização, edição, movimentação ou decisão)", async () => {
    await setLeadStage(handle, leadOfA1, "FOLLOW_UP_3", -1);
    const before = await row(leadOfA1);
    await as(org.ids.sellerA1);
    expect(await actions.redistributeLeadAction(IDLE, form({ leadId: leadOfA1, toSellerId: org.ids.sellerA2 }))).toMatchObject({
      message: FORBIDDEN,
    });
    expect(await actions.trashLeadAction(IDLE, form({ leadId: leadOfA1 }))).toMatchObject({ message: FORBIDDEN });
    for (const result of [
      await actions.addLeadNoteAction(IDLE, form({ leadId: leadOfA1, body: "Cliente respondeu depois do prazo." })),
      await actions.editLeadAction(IDLE, form({ leadId: leadOfA1, name: "Outro Nome", phone: "79 98000-0001", interestCourseId: courseId })),
      await actions.moveLeadStageAction(IDLE, form({ leadId: leadOfA1, toStage: "NEGOTIATION" })),
    ]) {
      expect(result).toMatchObject({ status: "error", message: AWAITING_SUPERVISOR_MESSAGE });
    }
    expect(await row(leadOfA1)).toEqual(before);
  });
});

describe("supervisor não opera outra equipe pela action", () => {
  it("transferir, enviar para a Lixeira, redistribuir e editar lead da equipe B: 404", async () => {
    await as(org.ids.supA);
    const results = [
      await actions.transferLeadAction(IDLE, form({ leadId: leadOfB1, toSellerId: org.ids.sellerA1 })),
      await actions.trashLeadAction(IDLE, form({ leadId: leadOfB1 })),
      await actions.redistributeLeadAction(IDLE, form({ leadId: leadOfB1, toSellerId: org.ids.sellerA1 })),
      await actions.editLeadAction(IDLE, form({ leadId: leadOfB1, name: "Invadido", phone: "79 98000-0002", interestCourseId: courseId })),
    ];
    for (const result of results) expect(result).toMatchObject({ status: "error", message: NOT_FOUND });
    expect(await row(leadOfB1)).toMatchObject({ ownerId: org.ids.sellerB1, status: "ACTIVE", name: "Lead do B1" });
    expect(await handle.db.select().from(leadEvents).where(eq(leadEvents.leadId, leadOfB1))).toHaveLength(1);
  });

  it("não transfere lead da própria equipe para vendedor de outra", async () => {
    await as(org.ids.supA);
    const result = await actions.transferLeadAction(IDLE, form({ leadId: leadOfA1, toSellerId: org.ids.sellerB1 }));
    expect(result).toMatchObject({ status: "error", fieldErrors: { toSellerId: ["Selecione um vendedor ativo da sua equipe."] } });
  });

  it("redistribui o lead com Follow-up 3 vencido da própria equipe", async () => {
    await as(org.ids.supA);
    const result = await actions.redistributeLeadAction(IDLE, form({ leadId: leadOfA1, toSellerId: org.ids.sellerA2 }));
    expect(result).toMatchObject({ status: "success" });
    expect(await row(leadOfA1)).toMatchObject({ ownerId: org.ids.sellerA2, stage: "REWORK" });
  });
});

describe("movimentação pela action (tentativas de burlar a máquina de estados)", () => {
  it("vendedor: destino fora do mapa, Fechamento e Retrabalho são recusados com mensagem de negócio", async () => {
    const id = (await createLead(await org.ctx(org.ids.sellerA1), { name: "Burla", phone: "79 98000-0100", interestCourseId: courseId })).id;
    await as(org.ids.sellerA1);
    const attempts = {
      FOLLOW_UP_3: "Movimentação não permitida: de Lead cadastrado para Follow-up 3.",
      CLOSED: "Fechamento só acontece ao registrar uma venda (disponível na fase de Vendas).",
      REWORK: "Retrabalho só acontece por redistribuição ou recuperação da Lixeira, feitas pelo supervisor.",
    };
    for (const [toStage, message] of Object.entries(attempts)) {
      expect(await actions.moveLeadStageAction(IDLE, form({ leadId: id, toStage }))).toMatchObject({ status: "error", message });
    }
    expect((await row(id)).stage).toBe("NEW");
    expect(await actions.moveLeadStageAction(IDLE, form({ leadId: id, toStage: "NO_ANSWER" }))).toMatchObject({
      status: "success",
      message: "Lead movido para Não respondeu.",
    });
  });

  it("supervisor e admin não movimentam; vendedor não movimenta lead de outro", async () => {
    const id = (await createLead(await org.ctx(org.ids.sellerA2), { name: "Do A2", phone: "79 98000-0101", interestCourseId: courseId })).id;
    for (const userId of [org.ids.supA, org.ids.admin]) {
      await as(userId);
      expect(await actions.moveLeadStageAction(IDLE, form({ leadId: id, toStage: "NO_ANSWER" }))).toMatchObject({ message: FORBIDDEN });
    }
    await as(org.ids.sellerA1);
    expect(await actions.moveLeadStageAction(IDLE, form({ leadId: id, toStage: "NO_ANSWER" }))).toMatchObject({ message: NOT_FOUND });
    expect((await row(id)).stage).toBe("NEW");
  });

  it("negociação vencida: a action de cadastro e a de mover outro lead devolvem o aviso do bloqueio", async () => {
    const negotiation = (await createLead(await org.ctx(org.ids.sellerB1), { name: "Negociando", phone: "79 98000-0102", interestCourseId: courseId })).id;
    const other = (await createLead(await org.ctx(org.ids.sellerB1), { name: "Outro", phone: "79 98000-0103", interestCourseId: courseId })).id;
    await setLeadStage(handle, negotiation, "NEGOTIATION", -1);
    await as(org.ids.sellerB1);
    const message = "Você possui uma negociação vencida. Atualize-a para continuar cadastrando ou movimentando leads.";
    expect(await actions.createLeadAction(IDLE, form({ name: "Mais Um", phone: "79 98000-0104", interestCourseId: courseId }))).toMatchObject({ message });
    expect(await actions.moveLeadStageAction(IDLE, form({ leadId: other, toStage: "NO_ANSWER" }))).toMatchObject({ message });
    expect(await actions.addLeadNoteAction(IDLE, form({ leadId: negotiation, body: "Atualizada." }))).toMatchObject({ status: "success" });
    expect(await actions.moveLeadStageAction(IDLE, form({ leadId: other, toStage: "NO_ANSWER" }))).toMatchObject({ status: "success" });
  });
});
