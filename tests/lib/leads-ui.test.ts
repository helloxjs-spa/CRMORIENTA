import { describe, expect, it } from "vitest";
import { leadActionsFor, leadCreationMode, moveTargetsFor } from "@/app/(app)/leads/policy";
import { boardParams, createdRangeInverted, hasResultFilters, leadsHref, parseLeadsParams, toListFilters } from "@/app/(app)/leads/search-params";
import type { Actor } from "@/server/authz/actor";
import { formatRelativeDateTime } from "@/lib/format";
import { describeLeadEvent } from "@/lib/lead-timeline";
import { deadlineInfo, STAGE_ORDER, stageFromSlug, stageToSlug } from "@/lib/leads";
import { LEAD_STAGES } from "@/server/db/schema";
import type { LeadTimelineEntry } from "@/server/modules/leads/leads.service";

// 2026-10-10 12:00 em São Paulo (UTC-3).
const NOW = new Date("2026-10-10T15:00:00Z");

describe("etapas", () => {
  it("a ordem de exibição é a mesma do enum do banco", () => {
    expect([...STAGE_ORDER]).toEqual([...LEAD_STAGES]);
  });

  it("slug da URL vai e volta", () => {
    for (const stage of STAGE_ORDER) expect(stageFromSlug(stageToSlug(stage))).toBe(stage);
    expect(stageToSlug("FOLLOW_UP_1")).toBe("follow-up-1");
    expect(stageFromSlug("qualquer")).toBeUndefined();
  });
});

describe("situação do prazo", () => {
  const base = { status: "ACTIVE" as const, ownerId: "a1", stage: "FOLLOW_UP_1" as const };

  it("no prazo, vence hoje, vencido e sem prazo", () => {
    expect(deadlineInfo({ ...base, stageDueAt: new Date("2026-10-11T15:00:00Z") }, NOW).kind).toBe("on_time");
    expect(deadlineInfo({ ...base, stageDueAt: new Date("2026-10-10T20:00:00Z") }, NOW).kind).toBe("due_today");
    expect(deadlineInfo({ ...base, stageDueAt: new Date("2026-10-10T14:00:00Z") }, NOW).kind).toBe("overdue");
    expect(deadlineInfo({ ...base, stage: "NO_ANSWER", stageDueAt: null }, NOW).kind).toBe("none");
  });

  it("23h59 de São Paulo ainda é hoje; 00h01 já é amanhã", () => {
    expect(deadlineInfo({ ...base, stageDueAt: new Date("2026-10-11T02:59:00Z") }, NOW).kind).toBe("due_today");
    expect(deadlineInfo({ ...base, stageDueAt: new Date("2026-10-11T03:01:00Z") }, NOW).kind).toBe("on_time");
  });

  it("Follow-up 3 vencido = aguardando supervisor; sem responsável e Lixeira têm estado próprio", () => {
    const due = new Date("2026-10-10T10:00:00Z");
    expect(deadlineInfo({ ...base, stage: "FOLLOW_UP_3", stageDueAt: due }, NOW).kind).toBe("awaiting_supervisor");
    expect(deadlineInfo({ ...base, ownerId: null, stageDueAt: due }, NOW).kind).toBe("unassigned");
    expect(deadlineInfo({ ...base, status: "TRASHED", stageDueAt: due }, NOW).kind).toBe("none");
  });
});

describe("data relativa", () => {
  it("hoje, ontem, amanhã e data completa no fuso de São Paulo", () => {
    expect(formatRelativeDateTime(new Date("2026-10-10T12:41:00Z"), NOW)).toBe("hoje 09:41");
    expect(formatRelativeDateTime(new Date("2026-10-09T18:20:00Z"), NOW)).toBe("ontem 15:20");
    expect(formatRelativeDateTime(new Date("2026-10-11T11:00:00Z"), NOW)).toBe("amanhã 08:00");
    expect(formatRelativeDateTime(new Date("2026-10-01T12:00:00Z"), NOW)).toBe("01/10/2026 09:00");
  });
});

describe("timeline: texto vem só do evento gravado", () => {
  const event = (overrides: Partial<LeadTimelineEntry>): LeadTimelineEntry => ({
    id: 1,
    type: "CREATED",
    occurredAt: NOW,
    actorName: "Ana Souza",
    cycleNumber: 1,
    cycleKind: "INITIAL",
    stage: "NEW",
    fromStage: null,
    ownerName: "Ana Souza",
    fromOwnerName: null,
    teamName: "Equipe A",
    fromTeamName: null,
    supervisorName: "Carlos",
    fromSupervisorName: null,
    unassignedReason: null,
    note: null,
    saleId: null,
    metadata: {},
    ...overrides,
  });

  it("transferência mostra de → para", () => {
    expect(describeLeadEvent(event({ type: "TRANSFERRED", fromOwnerName: "João", ownerName: "Maria" }))).toEqual({
      title: "Transferido",
      lines: ["João → Maria"],
    });
    expect(describeLeadEvent(event({ type: "TRANSFERRED", fromOwnerName: null, ownerName: "Maria" })).lines[0]).toBe("Sem responsável → Maria");
  });

  it("observação mostra o texto e a renovação do prazo da negociação", () => {
    const text = describeLeadEvent(
      event({ type: "NOTE_ADDED", stage: "NEGOTIATION", note: "Cliente pediu para retornar depois das 16h.", metadata: { renewedDueAt: "2026-10-11T15:00:00.000Z" } }),
      NOW,
    );
    expect(text).toEqual({
      title: "Atualização registrada",
      quote: "Cliente pediu para retornar depois das 16h.",
      lines: ["Prazo da negociação renovado até amanhã 12:00"],
    });
  });

  it("edição lista só os campos alterados, com telefone formatado e curso com instituição", () => {
    const text = describeLeadEvent(
      event({
        type: "DETAILS_UPDATED",
        metadata: {
          phone: { from: "5579999999999", to: "5579888888888" },
          interestCourse: { from: { id: "1", name: "Pedagogia", institutionName: "Alpha" }, to: { id: "2", name: "História", institutionName: "Beta" } },
        },
      }),
    );
    expect(text.lines).toEqual(["Telefone: (79) 99999-9999 → (79) 88888-8888", "Curso: Pedagogia — Alpha → História — Beta"]);
  });

  it("etapa, Lixeira, recuperação e sem responsável", () => {
    expect(describeLeadEvent(event({ type: "STAGE_CHANGED", stage: "FOLLOW_UP_1", fromStage: "NO_ANSWER" })).title).toBe("Movido para Follow-up 1");
    expect(describeLeadEvent(event({ type: "TRASHED", stage: "NO_ANSWER" })).lines).toEqual(["Etapa preservada: Não respondeu"]);
    expect(describeLeadEvent(event({ type: "RESTORED", stage: "REWORK", ownerName: "Bia", cycleNumber: 2 })).lines).toEqual([
      "Retrabalho com Bia",
      "Novo ciclo de atendimento: 2",
    ]);
    expect(describeLeadEvent(event({ type: "UNASSIGNED", ownerName: null, fromOwnerName: "João" })).lines[0]).toBe(
      "Responsável anterior: João (usuário desativado)",
    );
  });
});

describe("URL da tela de Leads", () => {
  it("lê filtros válidos e ignora os inválidos", () => {
    const id = "6f1c2a0e-1b2c-4d3e-8f90-123456789abc";
    expect(parseLeadsParams({ visao: "fila", motivo: "follow-up-3", q: " ana ", etapa: "em-negociacao", curso: "x", vendedor: id, pagina: "3", por: "50" })).toEqual({
      view: "fila",
      q: "ana",
      stage: undefined,
      course: undefined,
      seller: id,
      team: undefined,
      queue: "follow-up-3",
      page: 3,
      size: 50,
      lead: undefined,
    });
    expect(parseLeadsParams({ pagina: "-2", por: "30", visao: "admin" })).toMatchObject({ page: 1, size: 25, view: "carteira" });
  });

  it("monta a URL omitindo os padrões e volta ao mesmo estado", () => {
    const params = parseLeadsParams({ etapa: "follow-up-2", q: "79 9", pagina: "2" });
    const href = leadsHref(params);
    expect(href).toBe("/leads?q=79+9&etapa=follow-up-2&pagina=2");
    expect(parseLeadsParams(Object.fromEntries(new URL(href, "http://x").searchParams))).toEqual(params);
    expect(leadsHref(parseLeadsParams({}))).toBe("/leads");
  });

  it("vendedor não sai da própria carteira pela URL (sem fila, Lixeira, vendedor ou equipe)", () => {
    const id = "6f1c2a0e-1b2c-4d3e-8f90-123456789abc";
    const params = parseLeadsParams({ visao: "lixeira", vendedor: id, equipe: id });
    expect(toListFilters(params, { canManage: false, canFilterTeam: false })).toMatchObject({
      status: "ACTIVE",
      queue: undefined,
      ownerId: undefined,
      teamId: undefined,
    });
    expect(toListFilters(params, { canManage: true, canFilterTeam: true })).toMatchObject({ status: "TRASHED", ownerId: id, teamId: id });
  });

  it("data de cadastro De/Até: lê só datas válidas, volta pela URL e vira createdFrom/createdTo", () => {
    const params = parseLeadsParams({ de: "2026-09-01", ate: "2026-09-30" });
    expect(params).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    const href = leadsHref(params);
    expect(href).toBe("/leads?de=2026-09-01&ate=2026-09-30");
    expect(parseLeadsParams(Object.fromEntries(new URL(href, "http://x").searchParams))).toEqual(params);
    expect(hasResultFilters(params)).toBe(true);
    expect(createdRangeInverted(params)).toBe(false);
    expect(toListFilters(params, { canManage: false, canFilterTeam: false })).toMatchObject({ createdFrom: "2026-09-01", createdTo: "2026-09-30" });
    expect(parseLeadsParams({ de: "2026-02-30", ate: "30/09/2026" })).toMatchObject({ from: undefined, to: undefined });
    expect(toListFilters(parseLeadsParams({ de: "2026-09-01" }), { canManage: true, canFilterTeam: true })).toMatchObject({
      createdFrom: "2026-09-01",
      createdTo: undefined,
    });
  });

  it("intervalo invertido: a tela avisa e o filtro de data não é aplicado", () => {
    const params = parseLeadsParams({ de: "2026-09-30", ate: "2026-09-01" });
    expect(createdRangeInverted(params)).toBe(true);
    const filters = toListFilters(params, { canManage: true, canFilterTeam: true });
    expect(filters).not.toHaveProperty("createdFrom");
    expect(filters).not.toHaveProperty("createdTo");
  });

  it("Kanban não aplica nem repassa o filtro de data de cadastro", () => {
    const id = "6f1c2a0e-1b2c-4d3e-8f90-123456789abc";
    const board = boardParams(parseLeadsParams({ de: "2026-09-01", ate: "2026-09-30", etapa: "follow-up-1", vendedor: id }), true);
    expect(board).toMatchObject({ from: undefined, to: undefined, stage: undefined, view: "carteira", seller: id });
    expect(leadsHref(board, {}, "/kanban")).toBe(`/kanban?vendedor=${id}`);
    expect(hasResultFilters(boardParams(parseLeadsParams({ de: "2026-09-01" }), false))).toBe(false);
  });
});

describe("ações oferecidas pela interface (o backend revalida tudo)", () => {
  const seller: Pick<Actor, "role" | "userId"> = { role: "SELLER", userId: "a1" };
  const supervisor: Pick<Actor, "role" | "userId"> = { role: "SUPERVISOR", userId: "s1" };
  const free = { negotiationBlocked: false };
  const blocked = { negotiationBlocked: true };
  const future = new Date(Date.now() + 3_600_000);
  const past = new Date(Date.now() - 3_600_000);
  const lead = { status: "ACTIVE" as const, stage: "FOLLOW_UP_1" as const, ownerId: "a1", queueReason: null, stageDueAt: future };

  it("vendedor responsável: editar, registrar atualização e mover para os destinos do mapa", () => {
    expect(leadActionsFor(lead, seller, free)).toEqual(["edit", "note", "move"]);
    expect(moveTargetsFor(lead, seller, free)).toEqual(["FOLLOW_UP_2", "NEGOTIATION"]);
    expect(moveTargetsFor({ ...lead, ownerId: "a2" }, seller, free)).toEqual([]);
    expect(moveTargetsFor(lead, supervisor, free)).toEqual([]);
  });

  it("Follow-up 3 vencido: somente leitura para o vendedor; supervisor redistribui ou envia para a Lixeira", () => {
    const expired = { ...lead, stage: "FOLLOW_UP_3" as const, queueReason: "FOLLOW_UP_3_EXPIRED" as const, stageDueAt: past };
    expect(leadActionsFor(expired, seller, free)).toEqual([]);
    expect(moveTargetsFor(expired, seller, free)).toEqual([]);
    expect(leadActionsFor(expired, supervisor)).toEqual(["edit", "redistribute", "trash"]);
  });

  it("negociação vencida: só a própria negociação continua movimentável", () => {
    expect(moveTargetsFor(lead, seller, blocked)).toEqual([]);
    const overdue = { ...lead, stage: "NEGOTIATION" as const, stageDueAt: past };
    expect(moveTargetsFor(overdue, seller, blocked)).toEqual(["FOLLOW_UP_1"]);
    expect(leadActionsFor(lead, seller, blocked)).toEqual(["edit", "note"]);
  });

  it("sem responsável: transferir ou Lixeira (não é Retrabalho)", () => {
    expect(leadActionsFor({ ...lead, ownerId: null, queueReason: "UNASSIGNED" }, supervisor)).toEqual(["edit", "transfer", "trash"]);
  });

  it("Lixeira: só recuperar; Fechamento: nem transferir, nem Lixeira, nem mover", () => {
    expect(leadActionsFor({ ...lead, status: "TRASHED" }, supervisor)).toEqual(["restore"]);
    expect(leadActionsFor({ ...lead, status: "TRASHED" }, seller)).toEqual([]);
    expect(leadActionsFor({ ...lead, stage: "CLOSED" }, supervisor)).toEqual(["edit"]);
    expect(moveTargetsFor({ ...lead, stage: "CLOSED" }, seller, free)).toEqual([]);
  });
});

describe("cadastro de lead oferecido pela interface (C41, alinhado ao serviço)", () => {
  it("SELLER com equipe cadastra para si; sem equipe, não; SUPERVISOR e ADMIN escolhem o vendedor", () => {
    expect(leadCreationMode({ role: "SELLER", teamId: "teamA" })).toBe("own");
    expect(leadCreationMode({ role: "SELLER", teamId: null })).toBeNull();
    expect(leadCreationMode({ role: "SUPERVISOR", teamId: null })).toBe("chooseSeller");
    expect(leadCreationMode({ role: "ADMIN", teamId: null })).toBe("chooseSeller");
    expect(leadCreationMode({ role: "VISITANTE" as Actor["role"], teamId: null })).toBeNull();
  });
});
