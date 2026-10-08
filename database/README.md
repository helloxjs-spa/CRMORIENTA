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

## Testes e banco local

Os testes automatizados (e o banco local opcional `pglite://`) aplicam **os mesmos arquivos** desta pasta, em ordem, num PGlite. O migrador local cria antes os papéis `anon` e `authenticated` (que existem em todo Supabase) e registra o que já rodou em `crm_local.applied_migrations`, fora do schema `public`.
O teste `tests/db/migrations.test.ts` confere que o schema Drizzle (`src/server/db/schema`) tem exatamente as mesmas colunas que esses SQLs criam.

A pasta [`/drizzle`](../drizzle) guarda o histórico anterior (0000–0002), gerado pelo Drizzle antes da adoção do Supabase. Ela é preservada só como histórico e não é mais aplicada.
