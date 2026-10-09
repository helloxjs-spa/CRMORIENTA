# CRM Polo Educacional

CRM web para a operação comercial de um polo educacional: equipes, vendedores, leads, Kanban, follow-ups, vendas, parcelas, comissões, ranking, dashboards, certificados e auditoria.

- **Regras de negócio:** [`docs/Documento_Mestre_CRM_Polo_Educacional.pdf`](docs/Documento_Mestre_CRM_Polo_Educacional.pdf)
- **Arquitetura, modelo de dados, fases e dúvidas em aberto:** [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md)
- **Banco de dados (Supabase) e fluxo de alterações:** [`database/README.md`](database/README.md)

**Status:** Fase 0 (Fundação) e Fase 1 (Cursos) concluídas.

- **Fundação:** autenticação, perfis (Administrador, Supervisor, Vendedor), equipes, autorização no backend (RBAC + ownership + escopo de equipe), auditoria e layout autenticado.
- **Cursos:** curso + instituição, com custo da bolsa visível e editável só pelo administrador; lista de cursos ativos (curso e instituição, sem custo) para os demais perfis.

Os módulos comerciais seguintes aparecem no menu como "em breve".

## Banco de dados

O banco oficial é o **PostgreSQL do Supabase**, usado só como Postgres hospedado (a autenticação é própria do CRM, não usa Supabase Auth).

- O schema é criado e alterado **manualmente**, executando os SQLs de [`database/migrations/`](database/migrations) no SQL Editor do Supabase. A aplicação nunca altera o schema remoto.
- Os testes automatizados usam **PGlite** (Postgres em memória), que aplica exatamente os mesmos SQLs.

## Requisitos

- Node.js **20.9+** (testado com 22)
- Um projeto Supabase com os SQLs de `database/migrations/` já executados

## Como rodar

```bash
npm install
cp .env.example .env      # Windows (PowerShell): Copy-Item .env.example .env
# edite .env e defina DATABASE_URL com a connection string do Supabase
npm run dev               # http://localhost:3000
```

**Connection string:** no painel do Supabase, use **Connect › Session pooler** (porta 5432) ou a conexão direta, e acrescente `?sslmode=require`. Nunca faça commit do `.env`.

**Primeiro acesso:** o banco começa vazio. Crie o primeiro administrador com:

```bash
npm run admin:create
```

O comando pede nome, e-mail, senha e confirmação. A senha não aparece na tela e nunca é aceita por argumento, arquivo ou pipe. Antes de gravar, mostra o tipo de banco de destino (sem credenciais) e pede confirmação. Ele só funciona enquanto **não existir nenhum ADMIN**; depois disso, novos usuários são criados pela tela **Usuários**.

### Banco local opcional (sem Supabase)

Para experimentar sem tocar no Supabase, use `DATABASE_URL=pglite://.data/pglite` e rode `npm run setup`, que aplica os SQLs e cria dados fictícios. Só um processo pode abrir o PGlite por vez: pare o `npm run dev` antes de `db:migrate`, `db:seed` ou `db:reset`.

Usuários fictícios do seed (senha `Senha@123`, configurável em `SEED_PASSWORD`):

| Perfil | E-mail |
|---|---|
| Administrador | `admin@polo.local` |
| Supervisora (Equipe Alfa) | `ana.souza@polo.local` |
| Supervisor (Equipe Beta) | `bruno.lima@polo.local` |
| Vendedor (Equipe Alfa) | `lucas.alves.alfa@polo.local` |
| Vendedora (Equipe Beta) | `mariana.ferreira.beta@polo.local` |

Ao todo: 1 admin, 4 supervisores com suas equipes (Alfa, Beta, Gama, Delta), 10 vendedores por equipe e 9 cursos (Pedagogia em duas instituições; 1 curso inativo).

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento |
| `npm run build` / `npm start` | Build e servidor de produção |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript (`tsc --noEmit`) |
| `npm test` | Testes (Vitest; cada arquivo usa um Postgres em memória com os SQLs de `database/migrations`) |
| `npm run check` | lint + typecheck + testes |
| `npm run db:migrate` | Aplica os SQLs de `database/migrations` no **PGlite local**. Recusa Supabase |
| `npm run db:seed` | Cria dados fictícios; cada bloco (organização, cursos) só roda se a tabela estiver vazia. Contra o Supabase exige `-- --allow-remote` |
| `npm run db:reset` | Apaga e recria o **PGlite local**. Recusa Supabase |
| `npm run admin:create` | Cria o **primeiro** administrador no banco da `DATABASE_URL` (interativo; recusa se já houver ADMIN) |

## Produção

Use a mesma `DATABASE_URL` do Supabase (com os SQLs executados) e rode `npm run build && npm start` em qualquer host Node.js.
Com mais de uma instância, defina também `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` com o mesmo valor em todas elas.

## Segurança: o que já está garantido

- Sessão validada **no banco** a cada página e a cada Server Action. Desativar um usuário ou trocar a senha derruba as sessões abertas na hora.
- Permissões aplicadas nos **serviços** (`src/server/modules`), nunca apenas na interface. Server Actions chamadas diretamente, sem a tela, também são bloqueadas.
- Acesso fora do escopo (outro vendedor, outra equipe, ID alterado) retorna **404**, sem revelar que o registro existe.
- Entradas validadas com schemas estritos: campos extras como `role` ou `teamId` são rejeitados (mass assignment).
- Custo da bolsa em tabela separada, devolvido só por funções exclusivas do admin; vendedor e supervisor recebem apenas `{ id, name, institutionName }` dos cursos ativos.
- No banco: e-mail único, um supervisor por equipe, papel imutável, auditoria append-only, curso + instituição únicos e cursos sem exclusão física (triggers).
- Supabase: RLS ligado em todas as tabelas e nenhum acesso para `anon`/`authenticated`. A API REST pública do Supabase não expõe nenhum dado.

Os testes em [`tests/`](tests) cobrem esses pontos, incluindo "vendedor não acessa recursos de outro vendedor", "supervisor não acessa outra equipe" e "o schema do código bate com o banco".
