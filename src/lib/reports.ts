/**
 * Relatórios (Documento Mestre §20): tipos e textos usados pelo serviço e pela tela.
 */

export const REPORT_TYPES = ["leads", "sales", "items", "commissions", "performance", "installments", "certificates"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_LABELS: Record<ReportType, { title: string; description: string; period: string }> = {
  leads: { title: "Leads", description: "Leads no seu escopo, com etapa, responsável e situação.", period: "Data de cadastro" },
  sales: { title: "Vendas", description: "Uma linha por venda: cursos, pagamento, total, situação e estorno.", period: "Data da venda" },
  items: { title: "Itens vendidos", description: "Uma linha por curso vendido (itens atuais), com preço e comissão.", period: "Data da venda" },
  commissions: { title: "Comissões", description: "Comissão por vendedor: soma das comissões dos cursos das vendas válidas.", period: "Data da venda" },
  performance: { title: "Desempenho", description: "Ranking de vendedores ou equipes: vendas válidas e faturamento.", period: "Data da venda" },
  installments: { title: "Parcelas", description: "Parcelas do cartão (cronograma atual), com situação e pagamento.", period: "Vencimento" },
  certificates: { title: "Certificados", description: "Certificados registrados, com conclusão, entrega e certificadora.", period: "Conclusão ou entrega" },
};

/** Nome do arquivo exportado (sem acentos). */
export const REPORT_FILE_SLUGS: Record<ReportType, string> = {
  leads: "leads",
  sales: "vendas",
  items: "itens-vendidos",
  commissions: "comissoes",
  performance: "desempenho",
  installments: "parcelas",
  certificates: "certificados",
};

/** Teto técnico de linhas por arquivo (não é regra de negócio): acima disso, refine os filtros. */
export const REPORT_MAX_ROWS = 10_000;

export const REPORT_TOO_MANY_ROWS = `O relatório passa de ${REPORT_MAX_ROWS.toLocaleString("pt-BR")} linhas. Refine os filtros (por exemplo, um período menor).`;

/**
 * Erro da exportação devolvido à tela em `/relatorios?erro=<código>`. A URL
 * carrega só o código; a mensagem exibida é sempre uma destas (texto da URL
 * nunca é mostrado).
 */
export const REPORT_ERROR_MESSAGES = {
  permissao: "Você não tem permissão para exportar este relatório.",
  periodo: "A data inicial deve ser igual ou anterior à final.",
  limite: REPORT_TOO_MANY_ROWS,
  filtro: "Filtros inválidos. Confira os campos e tente novamente.",
  falha: "Não foi possível gerar o relatório. Tente novamente.",
} as const;
export type ReportErrorCode = keyof typeof REPORT_ERROR_MESSAGES;

/** Mensagem fixa do código; código desconhecido → mensagem genérica. */
export function reportErrorMessage(code: string): string {
  return Object.hasOwn(REPORT_ERROR_MESSAGES, code) ? REPORT_ERROR_MESSAGES[code as ReportErrorCode] : REPORT_ERROR_MESSAGES.falha;
}
