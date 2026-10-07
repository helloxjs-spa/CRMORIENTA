/**
 * Parâmetros de negócio centralizados. Nenhum destes valores deve ser repetido
 * em outros pontos do código: importe daqui.
 *
 * Nas fases de Vendas/Kanban, os valores que o cliente quiser alterar pela
 * interface migrarão para uma tabela de configurações, com o valor vigente
 * copiado (snapshot) em cada registro gerado (ex.: comissão em sale_items).
 */
export const BUSINESS_RULES = {
  /** Fuso único para "dia", vencimentos e filtros de período (Documento Mestre §25). */
  timezone: "America/Sao_Paulo",
  /** Comissão padrão por curso/aluno vendido, em centavos (Documento Mestre §14). */
  commissionPerItemCents: 100_00,
  /** Prazo de cada etapa de follow-up, em dias (Documento Mestre §7). */
  followUpDeadlineDays: 1,
  /** Prazo para atualizar uma negociação, em dias (Documento Mestre §8). */
  negotiationDeadlineDays: 1,
} as const;
