import { ForbiddenError } from "@/server/errors";
import type { UserRole } from "@/server/db/schema";
import type { Actor } from "./actor";

/**
 * Matriz RBAC central (Documento Mestre §4.4). Responde apenas "este PAPEL pode
 * executar esta AÇÃO?". Se o registro específico está no escopo do ator
 * (ownership / equipe) é decidido em ./scope.ts.
 *
 * Itens marcados "Não confirmado" no Documento Mestre ficam NEGADOS até
 * decisão do cliente (ver docs/ARQUITETURA.md, Dúvidas).
 *
 * Decisões do cliente que corrigem o Documento Mestre (docs/ARQUITETURA.md §8):
 * - Somente SELLER possui carteira comercial (leads e vendas próprios).
 * - Somente SUPERVISOR executa estorno; ADMIN tem visão global, não operação.
 */
const MATRIX = {
  // Organização (fase 1)
  "users:manage": ["ADMIN"],
  "users:view": ["ADMIN", "SUPERVISOR"],
  "teams:manage": ["ADMIN"],
  "teams:view": ["ADMIN", "SUPERVISOR"],
  "audit:view": ["ADMIN"],

  // Comercial (fases seguintes; declarado aqui para manter a matriz única)
  "leads:create": ["SELLER"],
  "leads:transfer": ["ADMIN", "SUPERVISOR"],
  "leads:redistribute": ["ADMIN", "SUPERVISOR"],
  "leads:trash": ["ADMIN", "SUPERVISOR"],
  "leads:restore": ["ADMIN", "SUPERVISOR"],
  "sales:create": ["SELLER"],
  "sales:reverse": ["SUPERVISOR"],
  "installments:markPaid": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Lista operacional de cursos ATIVOS, sem custo (usada em leads e vendas). */
  "courses:list": ["ADMIN", "SUPERVISOR", "SELLER"],
  "courses:manage": ["ADMIN"],
  "courses:viewCost": ["ADMIN"],
  "finance:viewCostAndProfit": ["ADMIN"],
  "certificates:operate": ["ADMIN", "SUPERVISOR", "SELLER"],
  "ranking:view": ["ADMIN", "SUPERVISOR", "SELLER"],
  "reports:export": ["ADMIN", "SUPERVISOR"],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof MATRIX;

export function hasPermission(actor: Pick<Actor, "role">, permission: Permission): boolean {
  return (MATRIX[permission] as readonly UserRole[]).includes(actor.role);
}

export function assertPermission(actor: Pick<Actor, "role">, permission: Permission): void {
  if (!hasPermission(actor, permission)) throw new ForbiddenError();
}
