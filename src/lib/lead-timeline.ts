import type { LeadTimelineEntry } from "@/server/modules/leads/leads.service";
import { formatRelativeDateTime } from "./format";
import { STAGE_LABELS } from "./leads";
import { formatPhone } from "./phone";

/**
 * Texto de cada evento da linha do tempo, montado SÓ a partir do que foi
 * gravado em lead_events (e da nota referenciada), nunca do estado atual.
 */
export type TimelineText = { title: string; lines: string[]; quote?: string };

type CourseSnapshot = { name: string; institutionName: string };

function isCourse(value: unknown): value is CourseSnapshot {
  return typeof value === "object" && value !== null && "name" in value && "institutionName" in value;
}

function change(metadata: Record<string, unknown>, key: string): { from: unknown; to: unknown } | null {
  const value = metadata[key];
  return typeof value === "object" && value !== null && "from" in value && "to" in value ? (value as { from: unknown; to: unknown }) : null;
}

function detailsLines(metadata: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const name = change(metadata, "name");
  if (name) lines.push(`Nome: ${String(name.from)} → ${String(name.to)}`);
  const phone = change(metadata, "phone");
  if (phone) lines.push(`Telefone: ${formatPhone(String(phone.from))} → ${formatPhone(String(phone.to))}`);
  const course = change(metadata, "interestCourse");
  if (course && isCourse(course.from) && isCourse(course.to)) {
    lines.push(
      `Curso: ${course.from.name} — ${course.from.institutionName} → ${course.to.name} — ${course.to.institutionName}`,
    );
  }
  return lines;
}

export function describeLeadEvent(event: LeadTimelineEntry, now: Date = new Date()): TimelineText {
  const owner = event.ownerName ?? "Sem responsável";
  const fromOwner = event.fromOwnerName ?? "Sem responsável";
  const teamMove = event.fromTeamName ? [`Equipe: ${event.fromTeamName} → ${event.teamName}`] : [];

  switch (event.type) {
    case "CREATED":
      return { title: "Lead cadastrado", lines: [`Responsável: ${owner} · equipe ${event.teamName}`] };
    case "STAGE_CHANGED":
      return {
        title: `Movido para ${STAGE_LABELS[event.stage]}`,
        lines: event.fromStage ? [`Etapa anterior: ${STAGE_LABELS[event.fromStage]}`] : [],
      };
    case "TRANSFERRED":
      return { title: "Transferido", lines: [`${fromOwner} → ${owner}`, ...teamMove] };
    case "TEAM_CHANGED":
      return { title: "Equipe alterada", lines: [`${event.fromTeamName ?? "—"} → ${event.teamName} (o responsável mudou de equipe)`] };
    case "UNASSIGNED":
      return {
        title: "Ficou sem responsável",
        lines: [`Responsável anterior: ${fromOwner} (usuário desativado)`, "Aguardando decisão do supervisor"],
      };
    case "REDISTRIBUTED":
      return {
        title: "Redistribuído em Retrabalho",
        lines: [`${fromOwner} → ${owner}`, ...teamMove, `Novo ciclo de atendimento: ${event.cycleNumber}`],
      };
    case "TRASHED":
      return { title: "Enviado para a Lixeira", lines: [`Etapa preservada: ${STAGE_LABELS[event.stage]}`] };
    case "RESTORED":
      return {
        title: "Recuperado da Lixeira",
        lines: [`Retrabalho com ${owner}`, ...teamMove, `Novo ciclo de atendimento: ${event.cycleNumber}`],
      };
    case "NOTE_ADDED": {
      const renewed = typeof event.metadata.renewedDueAt === "string" ? event.metadata.renewedDueAt : null;
      return {
        title: "Atualização registrada",
        quote: event.note ?? undefined,
        lines: renewed ? [`Prazo da negociação renovado até ${formatRelativeDateTime(renewed, now)}`] : [],
      };
    }
    case "DETAILS_UPDATED":
      return { title: "Dados atualizados", lines: detailsLines(event.metadata) };
  }
}
