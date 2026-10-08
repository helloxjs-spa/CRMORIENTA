@AGENTS.md

# CRM Polo Educacional — convenções

- Regras de negócio: `docs/Documento_Mestre_CRM_Polo_Educacional.pdf`. Não invente regras: o que não estiver definido vai para "Dúvidas em aberto" em `docs/ARQUITETURA.md`.
- Toda leitura ou escrita de dados de negócio passa por um serviço em `src/server/modules/<domínio>/` que recebe `ServiceContext` e aplica, nesta ordem: `assertPermission` (RBAC), escopo (`ownedScope`/`managedTeamScope`), validação `z.strictObject` via `parseInput`, e uma transação com `recordAudit` (ou `lead_events`) na mesma transação.
- Recursos com dono (leads, vendas, parcelas, certificados) SEMPRE compõem `ownedScope()` no WHERE, inclusive em busca por ID. Fora do escopo → `NotFoundError`.
- Server Actions são finas: `runAction(ctx => service(ctx, {campos explícitos}))`. Nunca passe `Object.fromEntries(formData)` para um serviço.
- Custos de bolsa e lucro: somente atrás de `courses:viewCost` / `finance:viewCostAndProfit`. Nunca inclua custo em payload de vendedor ou supervisor.
- Dinheiro em centavos (integer). Fuso e parâmetros de negócio em `src/server/config/business-rules.ts`; não repita valores (ex.: comissão) em outros arquivos.
- Nenhuma exclusão física de registros de negócio.
- Banco oficial: Supabase (só Postgres; sem Supabase Auth). Mudança de schema = NOVO arquivo `database/migrations/NNN_nome.sql` (com RLS + `REVOKE ALL ... FROM anon, authenticated` em tabelas novas), entregue ao usuário para execução manual no SQL Editor; PARE até ele confirmar. Nunca edite um SQL já executado; nunca aplique schema no Supabase pelo código; nunca imprima `DATABASE_URL`/segredos. Atualize o schema Drizzle para espelhar o SQL (o teste de paridade em `tests/db` confere).
- Antes de concluir: `npm run check`.
