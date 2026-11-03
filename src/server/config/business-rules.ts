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
  /**
   * Prazo de cada etapa de follow-up: 24 horas corridas a partir da entrada na
   * etapa (Documento Mestre §7; "1 dia" definido pelo cliente como 24 h).
   */
  followUpDeadlineHours: 24,
  /**
   * Horas de prazo consumidas a partir das quais o card do Kanban fica amarelo;
   * passado o prazo, fica vermelho (decisão do usuário em 02/11/2026).
   */
  deadlineWarningHours: 20,
  /** Prazo da negociação: 24 horas corridas desde a última atualização válida (§8). */
  negotiationDeadlineHours: 24,
  /**
   * Comprovantes de pagamento da venda (decisão do usuário em 31/10/2026):
   * opcionais, vários por venda, imagem ou PDF. O 007 tem um teto rígido de
   * 5 MB por arquivo; este limite não pode passar dele.
   */
  saleAttachmentMaxBytes: 5 * 1024 * 1024,
  /** Máximo de comprovantes ativos (não removidos) por venda. */
  saleAttachmentMaxPerSale: 20,
} as const;
