import { eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { NotFoundError } from "@/server/errors";
import type { Actor } from "./actor";

/**
 * Escopo de dados (ownership + equipe). Complementa o RBAC de ./permissions.ts:
 *
 *   ADMIN       → tudo.
 *   SUPERVISOR  → registros cuja equipe é a equipe que ele lidera.
 *   SELLER      → registros dos quais ele é o responsável (owner).
 *
 * Toda consulta de recurso com dono (leads, vendas, parcelas, certificados...)
 * deve compor `ownedScope()` no WHERE, inclusive buscas por ID. Assim, trocar um
 * ID na URL ou no payload simplesmente não encontra o registro (proteção IDOR).
 */

const NOTHING = sql`false`;

export type OwnedRecord = { ownerId: string | null; teamId: string | null };

export function canAccessOwned(actor: Actor, record: OwnedRecord): boolean {
  switch (actor.role) {
    case "ADMIN":
      return true;
    case "SUPERVISOR":
      return actor.supervisedTeamId !== null && record.teamId === actor.supervisedTeamId;
    case "SELLER":
      return record.ownerId === actor.userId;
  }
}

export function assertCanAccessOwned(actor: Actor, record: OwnedRecord | null | undefined): asserts record {
  if (!record || !canAccessOwned(actor, record)) throw new NotFoundError();
}

/** Filtro SQL equivalente a `canAccessOwned`. `undefined` = sem restrição. */
export function ownedScope(
  actor: Actor,
  columns: { ownerId: AnyPgColumn; teamId: AnyPgColumn },
): SQL | undefined {
  switch (actor.role) {
    case "ADMIN":
      return undefined;
    case "SUPERVISOR":
      return actor.supervisedTeamId ? eq(columns.teamId, actor.supervisedTeamId) : NOTHING;
    case "SELLER":
      return eq(columns.ownerId, actor.userId);
  }
}

/** Visão de gestão sobre uma equipe (dados agregados, membros, filas do time). */
export function canManageTeam(actor: Actor, teamId: string | null): boolean {
  if (actor.role === "ADMIN") return true;
  return actor.role === "SUPERVISOR" && teamId !== null && teamId === actor.supervisedTeamId;
}

export function assertCanManageTeam(actor: Actor, teamId: string | null): void {
  if (!canManageTeam(actor, teamId)) throw new NotFoundError();
}

/** Filtro SQL equivalente a `canManageTeam`. `undefined` = sem restrição. */
export function managedTeamScope(actor: Actor, teamColumn: AnyPgColumn): SQL | undefined {
  if (actor.role === "ADMIN") return undefined;
  if (actor.role === "SUPERVISOR" && actor.supervisedTeamId) return eq(teamColumn, actor.supervisedTeamId);
  return NOTHING;
}
