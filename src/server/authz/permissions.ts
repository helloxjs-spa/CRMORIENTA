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
 * - Somente SELLER possui carteira comercial: o responsável de lead e de venda
 *   é sempre um SELLER (C5).
 * - Vendas (C36, substitui C1): SELLER, SUPERVISOR e ADMIN registram (o
 *   responsável escolhido é sempre um vendedor); SUPERVISOR e ADMIN estornam
 *   e reativam; só o ADMIN escolhe a data da venda.
 */
const MATRIX = {
  // Organização (fase 1)
  "users:manage": ["ADMIN"],
  "users:view": ["ADMIN", "SUPERVISOR"],
  "teams:manage": ["ADMIN"],
  "teams:view": ["ADMIN", "SUPERVISOR"],
  "audit:view": ["ADMIN"],

  // Comercial (fases seguintes; declarado aqui para manter a matriz única)
  /** Ver leads: sempre combinado com o escopo (próprios / equipe / todos). */
  "leads:view": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Cadastrar lead: SELLER na própria carteira; SUPERVISOR/ADMIN escolhem o vendedor responsável (C41). */
  "leads:create": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Editar nome, telefone e curso de interesse: sempre combinado com o escopo. */
  "leads:edit": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Observações: quem opera o lead (o vendedor responsável). */
  "leads:addNote": ["SELLER"],
  /** Movimentar etapas no Kanban: só quem tem carteira (decisão C5). */
  "leads:move": ["SELLER"],
  "leads:transfer": ["ADMIN", "SUPERVISOR"],
  "leads:redistribute": ["ADMIN", "SUPERVISOR"],
  "leads:trash": ["ADMIN", "SUPERVISOR"],
  "leads:restore": ["ADMIN", "SUPERVISOR"],
  /** Ver vendas: sempre combinado com o escopo (próprias / equipe ATUAL do responsável / todas). */
  "sales:view": ["ADMIN", "SUPERVISOR", "SELLER"],
  /**
   * Registrar venda (C36). Quem pode ser o responsável é decidido no serviço:
   * SELLER escolhe a si ou um colega ativo da própria equipe; SUPERVISOR e
   * ADMIN, qualquer vendedor ativo; nunca vendedor de equipe inativa.
   */
  "sales:create": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Informar/alterar a data da venda (os demais registram com a data de hoje no fuso do negócio). */
  "sales:setDate": ["ADMIN"],
  /** Editar venda no escopo: incluir/remover cursos (itens). */
  "sales:edit": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Alterar valor total, forma de pagamento e parcelas. */
  "sales:editFinancial": ["ADMIN", "SUPERVISOR"],
  /** Trocar o vendedor responsável (o lead acompanha se a venda for válida). */
  "sales:changeSeller": ["ADMIN", "SUPERVISOR"],
  /** Corrigir venda estornada (para o vendedor ela é somente leitura). */
  "sales:editReversed": ["ADMIN", "SUPERVISOR"],
  /** Estornar e reativar (Etapa 3b; motivo obrigatório). */
  "sales:reverse": ["ADMIN", "SUPERVISOR"],
  "sales:reactivate": ["ADMIN", "SUPERVISOR"],
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
