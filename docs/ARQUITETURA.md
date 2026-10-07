# Arquitetura — CRM Polo Educacional

> Fonte das regras de negócio: [`Documento_Mestre_CRM_Polo_Educacional.pdf`](./Documento_Mestre_CRM_Polo_Educacional.pdf) (v1.0).
> Este arquivo registra **decisões técnicas**. Onde uma regra não está definida no Documento Mestre, ela aparece em [Dúvidas em aberto](#9-dúvidas-em-aberto) e **não** foi inventada no código.

---

## 1. Stack

| Camada | Escolha | Por quê |
|---|---|---|
| Linguagem | **TypeScript** (strict) | Tipagem ponta a ponta, do schema do banco até a tela. |
| Framework | **Next.js 16 (App Router)**, monólito | UI e backend no mesmo deploy, sem API separada para manter. Server Components leem dados no servidor; Server Actions fazem mutações. |
| Banco | **PostgreSQL** | Relacional, transações, índices únicos/parciais, CHECK, triggers — essenciais para unicidade de telefone e consistência financeira. |
| ORM / migrations | **Drizzle ORM + drizzle-kit** | SQL explícito e tipado, migrations em arquivos `.sql` versionados e revisáveis, sem engine binária. |
| Banco em dev/testes | **PGlite** (Postgres compilado para WASM) | Roda o **mesmo Postgres** sem Docker nem instalação. Testes usam uma instância em memória por arquivo. Produção usa Postgres real só trocando `DATABASE_URL`. |
| Autenticação | **Própria, com sessão no banco** | Token aleatório em cookie `httpOnly`; banco guarda só o SHA-256. Senha com `scrypt` nativo do Node. Sem dependência de bibliotecas beta; fácil de auditar. Revogação imediata (desativar usuário derruba as sessões). |
| Validação | **Zod 4** (`z.strictObject`) | Rejeita campos não previstos → proteção contra mass assignment. |
| UI | **Tailwind CSS 4** + componentes próprios + **lucide-react** | Visual consistente com a cor #082B59, sem kit pesado. Gráficos (fase de dashboards): Recharts. |
| Testes | **Vitest** + PGlite | Testes de autorização contra o banco real, rápidos e isolados. |

Descartado propositalmente: microserviços, filas, Redis, GraphQL, ORM com engine própria, Cache Components do Next (todas as telas são por usuário e precisam de dados atuais).

## 2. Arquitetura

```
Navegador
   │  (cookie de sessão httpOnly)
   ▼
src/proxy.ts ............ checagem OTIMISTA (sem cookie → /login). Não é barreira de segurança.
   ▼
src/app/** .............. Páginas (Server Components) e Server Actions — camada FINA:
   │                      lê a sessão, lê campos explícitos do FormData, chama um serviço.
   ▼
src/server/next/** ...... requireServiceContext(): valida a sessão NO BANCO a cada requisição
   │                      e monta { db, actor }. runAction(): converte erros em feedback.
   ▼
src/server/modules/** ... SERVIÇOS DE DOMÍNIO — a fronteira de segurança:
   │                      1) RBAC  (assertPermission)
   │                      2) Escopo (ownership / equipe) compondo o WHERE
   │                      3) Validação estrita (Zod)
   │                      4) Transação + auditoria na mesma transação
   ▼
src/server/db/** ........ Schema Drizzle, conexão, migrations (drizzle/)
   ▼
PostgreSQL .............. Constraints, índices únicos e triggers como defesa em profundidade
```

### Autorização: RBAC + ownership + escopo de equipe

- **RBAC** — [`src/server/authz/permissions.ts`](../src/server/authz/permissions.ts): matriz única `permissão → papéis`. Responde "este papel pode fazer esta ação?". Itens "Não confirmado" no Documento Mestre ficam **negados**.
- **Escopo** — [`src/server/authz/scope.ts`](../src/server/authz/scope.ts):
  - `ADMIN` → tudo; `SUPERVISOR` → registros da equipe que lidera; `SELLER` → registros dos quais é responsável.
  - `ownedScope(actor, {ownerId, teamId})` gera o filtro SQL que **toda** consulta de recurso com dono compõe, inclusive buscas por ID. Trocar o ID na URL/payload simplesmente não encontra o registro → **404, nunca 403** (não revela existência).
- **Actor** é recarregado do banco a cada requisição: mudança de equipe, desativação ou troca de supervisor valem imediatamente.
- **Custos de bolsa** (fase Cursos): ficarão em tabela própria (`course_costs`), lida apenas por funções que exigem `courses:viewCost`. Assim, nenhuma consulta de vendedor/supervisor tem como selecionar a coluna por engano.
- **Mass assignment**: Server Actions leem campos nominalmente; serviços validam com `z.strictObject` e nunca espalham o input em `insert/update`.
- **Server Actions são endpoints públicos**: cada uma revalida sessão e permissões no serviço. Verificado chamando a action diretamente com sessão de vendedor/supervisor (bloqueado).

## 3. Modelo de dados

Valores monetários sempre em **centavos (integer)**. Datas em `timestamptz` (UTC); "dia", vencimentos e filtros de período usam o fuso único **America/Sao_Paulo** ([`business-rules.ts`](../src/server/config/business-rules.ts)). Nada de negócio é apagado fisicamente.

### Implementado na fundação

| Tabela | Papel | Regras no banco |
|---|---|---|
| `users` | Usuário, papel (`ADMIN`/`SUPERVISOR`/`SELLER`), `team_id` do vendedor | e-mail único e minúsculo; só `SELLER` tem `team_id`; papel imutável (trigger) |
| `teams` | Equipe comercial, `supervisor_id` | nome único (sem diferenciar maiúsculas); um supervisor lidera no máximo uma equipe; `supervisor_id` precisa ser `SUPERVISOR` (trigger) |
| `sessions` | Sessões de login | id = SHA-256 do token; cascade ao remover usuário |
| `audit_events` | Log central de auditoria | **append-only** (trigger bloqueia UPDATE/DELETE) |

Relação **Empresa → Supervisor → Vendedores**: empresa única (implícita); `teams.supervisor_id` (1:1) e `users.team_id` (N:1).

### Planejado (próximas fases)

| Entidade | Responsabilidade | Observações de modelagem |
|---|---|---|
| `leads` | Pessoa/prospect | `phone_normalized` **UNIQUE** (E.164, só dígitos): a constraint resolve corrida entre cadastros simultâneos; o serviço traduz a violação em "lead já existe, responsável: X". Campos: `owner_id` (**sempre um SELLER**, garantido por trigger), `team_id` (equipe responsável **atual**), `stage`, `status`, `current_cycle_id`, `stage_entered_at`, `stage_due_at` |
| `lead_cycles` | **Ciclos de atendimento** | Um registro por tentativa comercial: `number` (1, 2, 3…), `kind` (`INITIAL` / `REWORK`), vendedor e equipe do ciclo, `started_at/by`, `ended_at`, `end_reason` (`FOLLOW_UP_EXPIRED`, `TRASHED`, `WON`, `TRANSFERRED`…). Permite saber se um Follow-up 1 pertence ao primeiro atendimento ou a um retrabalho |
| `lead_interests` | Cursos de interesse (N:N lead↔curso) | O documento fala em "curso(s) de interesse" |
| `lead_events` | **Linha do tempo do lead** (append-only) | Um registro por fato, sempre com `cycle_id`, `actor_id`, `occurred_at` e **retrato da equipe** (`team_id` no momento): criação, mudança de etapa (de/para), transferência (responsável/equipe de/para), mudança de equipe por troca do vendedor, redistribuição, lixeira, recuperação, venda. Substitui `LeadAssignmentHistory` + `LeadStageHistory` sem redundância |
| `lead_notes` | Observações e atualizações de negociação | Imutáveis; nova observação nunca sobrescreve; `lead_events` referencia a nota |
| `courses` | Curso (nome, ativo) | Sem coluna de custo (ver Fase Cursos) |
| `course_costs` | Custo de bolsa (1:1 com o curso) | Tabela separada, lida e escrita só pelo ADMIN. Histórico de alterações no `audit_events` (`course.cost_changed`) |
| `sales` | Cabeçalho: lead, vendedor, **`team_id` e `supervisor_id` da época (snapshot)**, data, valor total, forma de pagamento, status (`ACTIVE`/`REVERSED`), dados do estorno (quem, quando, motivo) | Faturamento, ranking e dashboards por equipe agrupam por `sales.team_id`, **nunca** pela equipe atual do vendedor. Estorno = colunas na própria venda (1:1) |
| `sale_items` | Um curso vendido | Snapshot de `scholarship_cost_cents` e `commission_cents` no momento da venda: relatórios históricos não mudam quando custo ou comissão mudarem |
| `installments` | Parcelas | `number`, `amount_cents`, `due_date`, `status` (`PENDING`/`PAID`), `paid_at`, `paid_by`; `UNIQUE(sale_id, number)`. Regras de geração (primeira data, recorrência, centavos) só serão definidas na fase financeira |
| `certificates` | Controle operacional | Vinculado a `sale_item` (aluno, curso, vendedor e data da venda vêm dele); conclusão, entrega, certificadora (texto) |
| `app_settings` | Parâmetros editáveis (ex.: comissão por curso) | O valor vigente é copiado nos registros gerados |

### Equipe "da época" × equipe atual

Decisão do cliente: quando o vendedor muda de equipe, **seus leads em aberto o acompanham**, mas **vendas e eventos passados ficam com a equipe em que ocorreram**.

- `users.team_id` e `leads.team_id` = situação **atual**: definem o escopo operacional (o novo supervisor passa a ver os leads; o anterior deixa de ver).
- `sales.team_id` / `sales.supervisor_id` e `lead_events.team_id` = **retrato do momento**, nunca reescritos. Os R$ 20.000 vendidos por João na Equipe A em setembro continuam na Equipe A.
- A troca em si fica em `audit_events` (`user.team_changed`) com quem executou, quando e um retrato de origem e destino: equipe e supervisor, com IDs e nomes (**já implementado**). Na fase Leads, a mesma transação atualizará `leads.team_id` dos leads em aberto e gravará um `lead_event` `TEAM_CHANGED` para cada um.

**Comissão não terá tabela própria**: é derivada de `sale_items.commission_cents` de vendas `ACTIVE`. O estorno muda o status da venda e a comissão deixa de contar automaticamente, sem risco de divergência. Se o cliente quiser controlar o **pagamento** de comissões ao vendedor, aí sim cria-se `commission_payouts`.

## 4. Kanban (estados)

As 9 colunas do Kanban misturam conceitos diferentes. Colocar todas num único enum permitiria estados impossíveis (ex.: lead na Lixeira com prazo de follow-up correndo). Modelo adotado, já com as decisões do cliente:

| Conceito | Modelagem | Valores |
|---|---|---|
| **Etapa do funil** | `leads.stage` (enum) | `NEW` (Lead Cadastrado), `NO_ANSWER`, `FOLLOW_UP_1`, `FOLLOW_UP_2`, `FOLLOW_UP_3`, `NEGOTIATION`, `CLOSED` (Fechamento), **`REWORK` (Retrabalho)** |
| **Situação do lead** | `leads.status` (enum) | `ACTIVE`, `TRASHED` (Lixeira), `WON` |
| **Ciclo de atendimento** | `lead_cycles` + `leads.current_cycle_id` | `INITIAL` (ciclo 1) e `REWORK` (ciclos 2, 3…) |
| **Vencimentos** | **derivados** de `stage_due_at < agora` | Follow-up vencido, "aguardando supervisor" (FU3 vencido) e negociação vencida são calculados, não gravados como estado. Sem cron e sem estado desatualizado |

**Prazos:** "1 dia" = **24 horas corridas** (decisão do cliente). `stage_due_at = stage_entered_at + 24h` nos follow-ups; na negociação, `última atualização válida + 24h`. Tudo em `timestamptz`; os parâmetros ficam em `business-rules.ts` (`followUpDeadlineHours`, `negotiationDeadlineHours`).

**Fluxo de retrabalho (decisão do cliente):**

```
FU3 vencido -> volta para o Supervisor -> Lixeira (status = TRASHED)
                                       -> Redistribuir: escolhe novo vendedor
                                            -> fecha o ciclo atual (end_reason = FOLLOW_UP_EXPIRED)
                                            -> abre ciclo N+1 (kind = REWORK) para o novo vendedor
                                            -> stage = REWORK (coluna visível no Kanban)
                                            -> vendedor move: REWORK -> FU1 -> FU2 -> FU3
```

- **Retrabalho é etapa visível**, e o ciclo registra a tentativa. Cada `lead_event` aponta para o seu ciclo, então "FU1 do 1º atendimento" e "FU1 do retrabalho" ficam distinguíveis no histórico.
- **Lixeira** é status, não etapa: preserva a etapa e o responsável em que o lead estava. A recuperação também abre um ciclo `REWORK` e coloca o lead em `REWORK` para o vendedor escolhido.
- **Fechamento** só é alcançado criando uma venda, na mesma transação. Não pode ser movido "à mão".
- **Bloqueio por negociação vencida**: um guard de backend (`assertSellerNotBlocked`) roda antes das mutações de lead do vendedor e verifica, via SQL, se existe `stage = NEGOTIATION AND stage_due_at < agora` para ele.

## 5. Estratégia de auditoria: combinação

- **`lead_events` + `lead_notes`** são a trilha oficial do lead (quem, quando, de → para). Atendem "Mudanças de estágio, responsável… devem produzir eventos" sem duplicar em outra tabela.
- **`audit_events`** (central, append-only) cobre o restante: autenticação, usuários, equipes, custos de curso, criação/estorno de venda, parcelas, certificados e mudanças financeiras. Guarda `team_id` para permitir auditoria por equipe ao supervisor.
- A tela de Auditoria (admin) poderá unir as duas fontes numa única linha do tempo.
- Registros de auditoria são gravados **na mesma transação** da mudança: se a mudança falhar, nada é auditado, e vice-versa.

## 6. Organização de módulos

```
src/
  app/                       # Rotas (camada fina)
    login/                   # Página + actions de login/logout
    (app)/                   # Área autenticada (layout com sidebar)
      page.tsx               # Início (por perfil)
      equipes/ usuarios/ perfil/ auditoria/
  components/
    ui/                      # Botão, campos, card, badge, tabela, diálogo, toast...
    layout/                  # AppShell, navegação por perfil, menu do usuário
  lib/                       # Utilitários puros (formatação, ActionState, cn)
  server/
    auth/                    # Senha, sessão, login, rate limit
    authz/                   # Actor, matriz RBAC, escopo
    config/business-rules.ts # Parâmetros de negócio centralizados
    db/                      # Schema, conexão (Postgres/PGlite), tipos, erros
    modules/<domínio>/       # Serviços: users, teams, audit (+ leads, sales... nas fases)
    next/                    # Ponte Next.js ↔ serviços (sessão, runAction, orNotFound)
  proxy.ts                   # Redirect otimista para /login
drizzle/                     # Migrations SQL versionadas
scripts/                     # migrate, seed, reset
tests/                       # Vitest (authz, auth, módulos, banco)
```

Cada novo domínio entra como `src/server/modules/<domínio>/` (serviço + schemas) + `src/app/(app)/<rota>/` (páginas e actions) + testes em `tests/modules/`.

## 7. Fases de implementação

| Fase | Escopo | Seções do Documento Mestre |
|---|---|---|
| **0. Fundação** ✅ | Projeto, banco, migrations, auth, papéis, equipes, RBAC/escopo, auditoria, layout | §3, §4, §25 |
| 1. Cursos | Cadastro de cursos, `course_costs` restrito ao admin, lista operacional sem custo | §10, §13 |
| 2. Leads | Cadastro, normalização e unicidade de telefone, transferência com histórico, `lead_events`/`lead_notes` | §5, §19 |
| 3. Kanban + Follow-up | Etapas, movimentação manual, prazos, vencidos, fila do supervisor | §6, §7 |
| 4. Negociação | Observações, vencimento, bloqueio do vendedor | §8 |
| 5. Retrabalho + Lixeira | Redistribuição, lixeira, recuperação, novo ciclo | §9 |
| 6. Vendas | Venda + itens + comissão + custo/lucro (admin) | §11, §13, §14 |
| 7. Pagamentos e parcelas | Pix/cartão, geração e baixa de parcelas | §12 |
| 8. Estorno | Cancelamento com motivo, área de estornos | §15 |
| 9. Ranking | Métrica × escopo × período | §16 |
| 10. Dashboards | Vendedor, supervisor, admin, comparativos mês a mês | §17 |
| 11. Certificados | Controle operacional | §18 |
| 12. Relatórios | CSV/Excel respeitando escopo | §20 |
| 13. Endurecimento | E2E, testes de cálculo, revisão de segurança | §24 |

## 8. Decisões

### Decisões do cliente (corrigem ou complementam o Documento Mestre)

| # | Decisão | Onde está refletida |
|---|---|---|
| C1 | **Estorno só pelo SUPERVISOR.** O ADMIN tem visão global, mas não executa automaticamente as ações operacionais | `sales:reverse` = `SUPERVISOR` (teste em `tests/authz/policies.test.ts`) |
| C2 | **"1 dia" = 24 horas corridas** desde a entrada na etapa ou a última atualização válida | `business-rules.ts`, §4 |
| C3 | **Retrabalho é etapa visível do Kanban**, e o histórico distingue os ciclos de follow-up | `stage = REWORK` + `lead_cycles`, §4 |
| C4 | **Vendedor que muda de equipe leva os leads em aberto**; vendas e eventos passados ficam com a equipe da época | §3 "Equipe da época × equipe atual"; auditoria da troca com retrato de origem e destino (implementado) |
| C5 | **Supervisor não tem carteira comercial.** Só o SELLER tem leads, vendas, follow-ups, negociações e comissões | `leads:create` e `sales:create` = `SELLER`; na fase Leads, um trigger garante que `leads.owner_id` seja sempre um SELLER |
| C6 | **Parcelas**: só a estrutura (número, valor, vencimento, status, data de pagamento). Regras de geração ficam para a fase financeira | §3 |

### Decisões técnicas

- **Política de senha**: mínimo de 8 caracteres; troca pelo próprio usuário exige a senha atual; o admin pode redefinir. Trocar ou redefinir a senha encerra todas as sessões. Não há recuperação por e-mail nesta fase (Documento Mestre §26).
- **Sessão**: 12 h (`SESSION_TTL_HOURS`), sem renovação deslizante.
- **Login**: mensagem genérica, tempo constante para e-mail inexistente, limite de 10 tentativas a cada 15 min por e-mail+IP (em memória; com múltiplas instâncias, mover para o Postgres).
- **Papel do usuário é imutável** depois de criado (trigger). Trocar papel tem efeitos em equipes, leads e vendas que ainda não foram definidos.
- **Desativar supervisor** exige antes definir outro supervisor para a equipe que ele lidera. **Inativar equipe** exige que ela não tenha vendedores ativos.
- **Acesso negado em páginas** responde **404** (não revela existência). Não há `loading.tsx` envolvendo páginas com checagem de acesso, para que o status HTTP seja real.

## 9. Dúvidas em aberto

Resolvidas pelo cliente: estorno (C1), prazo de 1 dia (C2), retrabalho (C3), troca de equipe (C4), supervisor sem carteira (C5) e parcelas (C6, adiada para a fase financeira). Pendentes:

| # | Dúvida | Contexto | Padrão atual | Fase |
|---|---|---|---|---|
| 1 | O **admin executa os fluxos operacionais de leads** (transferir, redistribuir, lixeira, recuperar)? | §4.1 e §4.4 dizem que sim; a decisão C1 diz que visão global ≠ operação | Matriz permite ao admin (conforme §4.1/§4.4); confirmar | Leads |
| 2 | Vendedor pode **transferir lead**? | §4.4: "Não confirmado" | Negado | Leads |
| 3 | Vendedor pode **exportar relatórios** (só os próprios dados)? | §4.4: "Não confirmado" | Negado | Relatórios |
| 4 | **Depois da venda**: o lead fica em Fechamento? Pode comprar de novo depois? Se a venda for **estornada**, volta para qual etapa? | Não definido | — | Vendas/Estorno |
| 5 | **Supervisor vê lucro/custo agregado do time?** | §17.2 × regra "não visualiza custos" | Custo e lucro só para admin | Dashboards |
| 6 | **"Por curso/aluno"**: uma venda pode ter cursos de **alunos diferentes**? | §14 e RA-03 | Item = curso; aluno = lead da venda | Vendas |
| 7 | **Custo de bolsa alterado**: vendas antigas mantêm o custo da época? | §26 | Proposta: sim (snapshot em `sale_items`) | Vendas |
| 8 | **Negociação vencida bloqueia o quê exatamente?** | §8: "cadastrar novos leads ou movimentar outras frentes do Kanban" | Proposta: bloquear criação de lead e movimentação de outros leads; parcelas e certificados liberados | Negociação |
| 9 | **FU3 vencido**: o lead continua com o mesmo responsável (só some da fila dele) até o supervisor decidir? | §7 | Proposta: mantém o responsável, marcado como "aguardando supervisor" | Kanban |
| 10 | Campos adicionais do lead (e-mail, CPF, cidade)? | §26 | Só os campos mínimos | Leads |
| 11 | Formato e colunas de cada relatório | §26 | — | Relatórios |
