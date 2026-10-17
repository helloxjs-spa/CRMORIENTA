# Banco de dados — Supabase (PostgreSQL)

O banco oficial do CRM é o **PostgreSQL do Supabase**, usado apenas como Postgres hospedado (**sem Supabase Auth**; autenticação e sessões são da aplicação). A aplicação conecta pela variável `DATABASE_URL`.

## Fluxo de alterações (manual)

1. A alteração é escrita como um novo arquivo SQL em [`migrations/`](migrations), numerado em sequência (`002_...sql`, `003_...sql`).
2. O SQL é executado **manualmente** no SQL Editor do Supabase, por uma pessoa.
3. Só depois da confirmação é implementado o código que depende da alteração.

Regras:

- **Nunca editar um arquivo já executado no Supabase.** Correções viram um novo script (ex.: `004_fix_...sql`).
- Alterações destrutivas (DROP, TRUNCATE, DELETE em massa, mudança de tipo com perda, remoção de constraint) são sinalizadas com `ATENÇÃO: ALTERAÇÃO DESTRUTIVA`, com o risco explicado antes.
- Regras críticas ficam também no banco (UNIQUE, CHECK, FK, triggers), não só no código.
- Toda tabela nova no schema `public` recebe `ENABLE ROW LEVEL SECURITY` e `REVOKE ALL ... FROM anon, authenticated`. A Data API (PostgREST) do Supabase não é usada pelo CRM e não pode expor dados.
- A aplicação **nunca** aplica migrations no Supabase: `npm run db:migrate` e `npm run db:reset` recusam URLs `postgres://`/`postgresql://`.

## Convenções

| Item | Convenção |
|---|---|
| IDs | `uuid` gerado pelo Postgres (`DEFAULT gen_random_uuid()`, nativo do PG 13+, sem extensão). `audit_events` usa `bigserial` (ordem cronológica e paginação) |
| Datas/horas | `timestamp with time zone`, `DEFAULT now()`. `updated_at` é preenchido pela aplicação a cada UPDATE. Regras de "dia" usam o fuso America/Sao_Paulo; prazos são 24 h corridas |
| Dinheiro | `integer` em **centavos** (R$ 300,00 = `30000`), com `CHECK (>= 0)` onde aplicável. Nunca float |
| Exclusão | Registros de negócio não são apagados fisicamente (`active`/status + triggers) |

## Histórico

| Arquivo | Conteúdo | Executado no Supabase |
|---|---|---|
| [`001_supabase_initial_schema.sql`](migrations/001_supabase_initial_schema.sql) | Fundação (users, teams, sessions, audit_events), cursos e custos, com `institution_name` | ✅ 2026-10-08 |
| [`002_leads.sql`](migrations/002_leads.sql) | Leads: `leads`, `lead_cycles`, `lead_notes`, `lead_events`, 6 enums, telefone canônico único (inclusive na Lixeira), triggers de integridade (responsável SELLER ativo da mesma equipe, coerência lead × ciclos, append-only, sem DELETE/TRUNCATE) e o trigger `users_seller_open_leads` em `users` | ✅ 2026-10-10 |
| [`003_sales.sql`](migrations/003_sales.sql) | Vendas: `sales`, `sale_items`, `sale_events`, 3 enums, `REOPENED` e eventos `SALE_*` nos leads, `lead_events.sale_id`, auditoria calculada e conferida pelo banco no COMMIT, coerência lead × vendas, exigência de READ COMMITTED. SHA-256 `843e66a127c38a35a66a8067eeb1444374115482127e96279fd947cf6ba7eabd` (CRLF; `.gitattributes` preserva os bytes) | ✅ |
| [`004_sale_item_prices.sql`](migrations/004_sale_item_prices.sql) | Preço de venda por item (`sale_items.price_cents > 0`), total da venda = soma dos itens atuais (conferido no COMMIT), correção de preço no próprio item preservando custo e comissão, com antes/depois no `UPDATED` (`itemsRepriced`). Só aplica com `sales`/`sale_items` vazias (guard sob trava exclusiva). SHA-256 `1233df8bef5270363d95500166e3662b0015707b17581e2237d50749bad21267` | ✅ executada e verificada (`price_nullable = NO`, `snapshot_ok = true`, `total_check_ok = true`, `anon_exec = false`) |
| [`005_certificates.sql`](migrations/005_certificates.sql) | Certificados: `certificates` (um por item de venda; conclusão, entrega ≥ conclusão, certificadora em texto livre), sem DELETE/TRUNCATE, item/autor/data de registro imutáveis, RLS + `REVOKE`. Não altera nada existente. SHA-256 `6f8ad865d95175304be102329661172ff6691b954c73da165a80c37fd169e829` | ✅ executada e verificada (informado pelo proprietário) |
| [`006_installments.sql`](migrations/006_installments.sql) | Parcelas do cartão: enum `installment_status`, `installments` (cronograma atual + substituídos como histórico), cronograma conferido no COMMIT contra a venda (regra C52), transições e imutabilidade por trigger, sem DELETE/TRUNCATE, RLS + `REVOKE`; cria o cronograma das vendas no cartão já existentes. Não depende da 005. **Implantar junto do código de Parcelas**: depois dela, a versão anterior da aplicação não registra vendas no cartão. SHA-256 `d31df7417fb7f9f45ab6a32a2671d4a47fe36997aa268ed1deeb64d9648b8724` | ✅ executada e verificada (informado pelo proprietário) |

## Testes e banco local

Os testes automatizados (e o banco local opcional `pglite://`) aplicam **os mesmos arquivos** desta pasta, em ordem, num PGlite. O migrador local cria antes os papéis `anon` e `authenticated` (que existem em todo Supabase) e registra o que já rodou em `crm_local.applied_migrations`, fora do schema `public`.
O teste `tests/db/migrations.test.ts` confere que o schema Drizzle (`src/server/db/schema`) tem exatamente as mesmas colunas que esses SQLs criam.

A pasta [`/drizzle`](../drizzle) guarda o histórico anterior (0000–0002), gerado pelo Drizzle antes da adoção do Supabase. Ela é preservada só como histórico e não é mais aplicada.
