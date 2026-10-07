# CRM Polo Educacional

CRM web para a operação comercial de um polo educacional: equipes, vendedores, leads, Kanban, follow-ups, vendas, parcelas, comissões, ranking, dashboards, certificados e auditoria.

- **Regras de negócio:** [`docs/Documento_Mestre_CRM_Polo_Educacional.pdf`](docs/Documento_Mestre_CRM_Polo_Educacional.pdf)
- **Arquitetura, modelo de dados, fases e dúvidas em aberto:** [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md)

**Status:** Fase 0 (Fundação) e Fase 1 (Cursos) concluídas.

- **Fundação:** autenticação, perfis (Administrador, Supervisor, Vendedor), equipes, autorização no backend (RBAC + ownership + escopo de equipe), auditoria e layout autenticado.
- **Cursos:** cadastro com custo da bolsa visível e editável só pelo administrador; lista de cursos ativos sem custo para os demais perfis.

Os módulos comerciais seguintes aparecem no menu como "em breve".

## Requisitos

- Node.js **20.9+** (testado com 22)
- Não precisa de Docker nem de Postgres instalado em desenvolvimento: o projeto usa o **PGlite** (Postgres embutido) gravado em `.data/`.

## Como rodar

```bash
npm install
cp .env.example .env      # Windows (PowerShell): Copy-Item .env.example .env
npm run setup             # aplica as migrations e cria os usuários fictícios
npm run dev               # http://localhost:3000
```

> **PGlite:** só um processo pode abrir o banco local por vez. Pare o `npm run dev` antes de rodar `db:migrate`, `db:seed` ou `db:reset`.

### Usuários fictícios (seed)

Senha de todos: `Senha@123` (configurável em `SEED_PASSWORD`).

| Perfil | E-mail |
|---|---|
| Administrador | `admin@polo.local` |
| Supervisora (Equipe Alfa) | `ana.souza@polo.local` |
| Supervisor (Equipe Beta) | `bruno.lima@polo.local` |
| Vendedor (Equipe Alfa) | `lucas.alves.alfa@polo.local` |
| Vendedora (Equipe Beta) | `mariana.ferreira.beta@polo.local` |

Ao todo: 1 admin, 4 supervisores com suas equipes (Alfa, Beta, Gama, Delta), 10 vendedores por equipe e 8 cursos (1 inativo). Os e-mails dos vendedores seguem o padrão `nome.sobrenome.equipe@polo.local`; a lista completa está na tela **Usuários** do admin.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento |
| `npm run build` / `npm start` | Build e servidor de produção |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript (`tsc --noEmit`) |
| `npm test` | Testes (Vitest; cada arquivo usa um Postgres em memória) |
| `npm run check` | lint + typecheck + testes |
| `npm run db:generate` | Gera uma migration SQL a partir de mudanças no schema (`src/server/db/schema`) |
| `npm run db:migrate` | Aplica as migrations pendentes |
| `npm run db:seed` | Cria os dados fictícios: cada bloco (organização, cursos) só roda se a tabela estiver vazia; bloqueado em produção |
| `npm run db:reset` | Apaga o banco de desenvolvimento e reaplica as migrations (bloqueado em produção) |

## Usando PostgreSQL real (produção)

Defina no `.env` (ou nas variáveis do ambiente de deploy):

```
DATABASE_URL=postgresql://usuario:senha@host:5432/crm_polo
```

Depois rode `npm run db:migrate` e `npm run build && npm start`. Funciona em qualquer host Node.js com Postgres gerenciado (Neon, Supabase, RDS, Railway, Render…).
Com mais de uma instância, defina também `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` com o mesmo valor em todas elas.

## Segurança: o que já está garantido

- Sessão validada **no banco** a cada página e a cada Server Action. Desativar um usuário ou trocar a senha derruba as sessões abertas na hora.
- Permissões aplicadas nos **serviços** (`src/server/modules`), nunca apenas na interface. Server Actions chamadas diretamente, sem a tela, também são bloqueadas.
- Acesso fora do escopo (outro vendedor, outra equipe, ID alterado) retorna **404**, sem revelar que o registro existe.
- Entradas validadas com schemas estritos: campos extras como `role` ou `teamId` são rejeitados (mass assignment).
- Custo da bolsa em tabela separada, devolvido só por funções exclusivas do admin; vendedor e supervisor recebem apenas `{ id, name }` dos cursos ativos.
- No banco: e-mail único, um supervisor por equipe, papel imutável, auditoria append-only e cursos sem exclusão física (triggers).

Os testes em [`tests/`](tests) cobrem esses pontos, incluindo "vendedor não acessa recursos de outro vendedor" e "supervisor não acessa outra equipe".
