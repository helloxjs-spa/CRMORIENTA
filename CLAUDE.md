@AGENTS.md

# CRM Polo Educacional — convenções

- Regras de negócio: `docs/Documento_Mestre_CRM_Polo_Educacional.pdf`. Não invente regras: o que não estiver definido vai para "Dúvidas em aberto" em `docs/ARQUITETURA.md`.
- Toda leitura ou escrita de dados de negócio passa por um serviço em `src/server/modules/<domínio>/` que recebe `ServiceContext` e aplica, nesta ordem: `assertPermission` (RBAC), escopo (`ownedScope`/`managedTeamScope`), validação `z.strictObject` via `parseInput`, e uma transação com `recordAudit` (ou `lead_events`) na mesma transação.
- Recursos com dono (leads, vendas, parcelas, certificados) SEMPRE compõem `ownedScope()` no WHERE, inclusive em busca por ID. Fora do escopo → `NotFoundError`.
- Server Actions são finas: `runAction(ctx => service(ctx, {campos explícitos}))`. Nunca passe `Object.fromEntries(formData)` para um serviço.
- Custos de bolsa e lucro: somente atrás de `courses:viewCost` / `finance:viewCostAndProfit`. Nunca inclua custo em payload de vendedor ou supervisor.
- Dinheiro em centavos (integer). Fuso e parâmetros de negócio em `src/server/config/business-rules.ts`; não repita valores (ex.: comissão) em outros arquivos.
- Nenhuma exclusão física de registros de negócio.
- Mudou o schema? `npm run db:generate` e revise o SQL gerado. Antes de concluir: `npm run check`.
