# Arquitetura — CRM Polo Educacional

> Fonte das regras de negócio: [`Documento_Mestre_CRM_Polo_Educacional.pdf`](./Documento_Mestre_CRM_Polo_Educacional.pdf) (v1.0).
> Este arquivo registra **decisões técnicas**. Onde uma regra não está definida no Documento Mestre, ela aparece em [Dúvidas em aberto](#9-dúvidas-em-aberto) e **não** foi inventada no código.

---

## 1. Stack

| Camada | Escolha | Por quê |
|---|---|---|
| Linguagem | **TypeScript** (strict) | Tipagem ponta a ponta, do schema do banco até a tela. |
| Framework | **Next.js 16 (App Router)**, monólito | UI e backend no mesmo deploy, sem API separada para manter. Server Components leem dados no servidor; Server Actions fazem mutações. |
| Banco | **PostgreSQL no Supabase** (só como Postgres hospedado; sem Supabase Auth) | Relacional, transações, índices únicos/parciais, CHECK, triggers — essenciais para unicidade de telefone e consistência financeira. |
| ORM / migrations | **Drizzle ORM** + SQLs manuais em `database/migrations` | Drizzle só para consultas tipadas. O schema é alterado por SQLs versionados, executados manualmente no SQL Editor do Supabase ([database/README.md](../database/README.md)). |
| Banco de testes | **PGlite** (Postgres compilado para WASM) | Cada arquivo de teste sobe um Postgres em memória e aplica **os mesmos SQLs** executados no Supabase. Um teste confere que o schema Drizzle bate com o banco. |
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
src/server/db/** ........ Schema Drizzle (espelha database/migrations), conexão
   ▼
PostgreSQL .............. Constraints, índices únicos e triggers como defesa em profundidade
```

### Autorização: RBAC + ownership + escopo de equipe

- **RBAC** — [`src/server/authz/permissions.ts`](../src/server/authz/permissions.ts): matriz única `permissão → papéis`. Responde "este papel pode fazer esta ação?". Itens "Não confirmado" no Documento Mestre ficam **negados**.
- **Escopo** — [`src/server/authz/scope.ts`](../src/server/authz/scope.ts):
  - `ADMIN` → tudo; `SUPERVISOR` → registros da equipe que lidera; `SELLER` → registros dos quais é responsável.
  - `ownedScope(actor, {ownerId, teamId})` gera o filtro SQL que **toda** consulta de recurso com dono compõe, inclusive buscas por ID. Trocar o ID na URL/payload simplesmente não encontra o registro → **404, nunca 403** (não revela existência).
- **Actor** é recarregado do banco a cada requisição: mudança de equipe, desativação ou troca de supervisor valem imediatamente.
- **Custos de bolsa**: ficam em tabela própria (`course_costs`), lida apenas pelas funções `*WithCost`, que exigem `courses:viewCost` (ADMIN). Nenhuma consulta de vendedor/supervisor tem como selecionar a coluna por engano. Detalhes em [Cursos](#cursos-fase-1).
- **Mass assignment**: Server Actions leem campos nominalmente; serviços validam com `z.strictObject` e nunca espalham o input em `insert/update`.
- **Server Actions são endpoints públicos**: cada uma revalida sessão e permissões no serviço. Verificado chamando a action diretamente com sessão de vendedor/supervisor (bloqueado).

## 3. Modelo de dados

Valores monetários sempre em **centavos (integer)**. Datas em `timestamptz` (UTC); "dia", vencimentos e filtros de período usam o fuso único **America/Sao_Paulo** ([`business-rules.ts`](../src/server/config/business-rules.ts)). Nada de negócio é apagado fisicamente.

### Implementado

| Tabela | Papel | Regras no banco |
|---|---|---|
| `users` | Usuário, papel (`ADMIN`/`SUPERVISOR`/`SELLER`), `team_id` do vendedor | e-mail único e minúsculo; só `SELLER` tem `team_id`; papel imutável (trigger) |
| `teams` | Equipe comercial, `supervisor_id` | nome único (sem diferenciar maiúsculas); um supervisor lidera no máximo uma equipe; `supervisor_id` precisa ser `SUPERVISOR` (trigger) |
| `sessions` | Sessões de login | id = SHA-256 do token; cascade ao remover usuário |
| `audit_events` | Log central de auditoria | **append-only** (trigger bloqueia UPDATE/DELETE) |
| `courses` *(Fase 1)* | Curso: nome, **instituição** (`institution_name`), ativo/inativo, timestamps | par curso + instituição único (sem diferenciar maiúsculas/espaços); nome e instituição não vazios; **sem coluna de custo**; DELETE bloqueado por trigger |
| `course_costs` *(Fase 1)* | Custo da bolsa em centavos (1:1 com o curso), `updated_at`, `updated_by` | `cost_cents >= 0`; DELETE bloqueado por trigger |
| `leads` *(Fase 2)* | Lead: nome, `phone` canônico, curso de interesse (obrigatório), `owner_id` (vendedor; NULL = fila do supervisor), `team_id` (equipe **atual**, sempre preenchida), `stage`, `stage_entered_at`, `stage_due_at`, `status`, Lixeira (`trashed_at/by`), fila (`unassigned_at/reason`), `created_at` = data de cadastro | `phone` **UNIQUE para todos os leads, inclusive na Lixeira**, e `CHECK` de formato (55 + DDD válido + celular com 9º dígito ou fixo); prazo só em FU1/2/3 e Negociação; Lixeira e fila coerentes; responsável em operação = SELLER **ativo** da **mesma equipe** (trigger); `created_at/by` imutáveis; sem DELETE/TRUNCATE |
| `lead_cycles` *(Fase 2)* | Ciclos de atendimento: `number`, `kind` (`INITIAL`/`REWORK`), vendedor e equipe que receberam o ciclo, abertura, encerramento (`REDISTRIBUTED`/`TRASHED`/`WON`) | no máximo **um ciclo aberto** por lead; lead em operação tem exatamente um, e é o mais recente; na Lixeira ou fechado, nenhum (verificado no COMMIT); ciclo encerrado imutável |
| `lead_notes` *(Fase 2)* | Observações: autor, texto, ciclo e etapa (contexto), `created_at` | append-only (UPDATE/DELETE/TRUNCATE bloqueados); ciclo do mesmo lead (FK composta) |
| `lead_events` *(Fase 2)* | Linha do tempo do lead: tipo, ator, momento, ciclo e **retrato depois do fato** (etapa, responsável, equipe, supervisor) + valores anteriores (`from_*`) | append-only; regras por tipo (ex.: `TRANSFERRED` exige novo responsável diferente; `UNASSIGNED` exige motivo) |

Relação **Empresa → Supervisor → Vendedores**: empresa única (implícita); `teams.supervisor_id` (1:1) e `users.team_id` (N:1).

### Planejado (próximas fases)

| Entidade | Responsabilidade | Observações de modelagem |
|---|---|---|
| `sales` | Cabeçalho: lead, vendedor, **`team_id` e `supervisor_id` da época (snapshot)**, data, valor total, forma de pagamento, status (`ACTIVE`/`REVERSED`), dados do estorno (quem, quando, motivo) | Faturamento, ranking e dashboards por equipe agrupam por `sales.team_id`, **nunca** pela equipe atual do vendedor. Estorno = colunas na própria venda (1:1) |
| `sale_items` | Um curso vendido | Snapshot de `scholarship_cost_cents` e `commission_cents` no momento da venda: relatórios históricos não mudam quando custo ou comissão mudarem |
| `installments` | Parcelas | `number`, `amount_cents`, `due_date`, `status` (`PENDING`/`PAID`), `paid_at`, `paid_by`; `UNIQUE(sale_id, number)`. Regras de geração (primeira data, recorrência, centavos) só serão definidas na fase financeira |
| `certificates` | Controle operacional | Vinculado a `sale_item` (aluno, curso, vendedor e data da venda vêm dele); conclusão, entrega, certificadora (texto) |
| `app_settings` | Parâmetros editáveis (ex.: comissão por curso) | O valor vigente é copiado nos registros gerados |

### Equipe "da época" × equipe atual

Decisão do cliente: quando o vendedor muda de equipe, **seus leads em aberto o acompanham**, mas **vendas e eventos passados ficam com a equipe em que ocorreram**.

- `users.team_id` e `leads.team_id` = situação **atual**: definem o escopo operacional (o novo supervisor passa a ver os leads; o anterior deixa de ver).
- `sales.team_id` / `sales.supervisor_id` e `lead_events.team_id` = **retrato do momento**, nunca reescritos. Os R$ 20.000 vendidos por João na Equipe A em setembro continuam na Equipe A.
- A troca em si fica em `audit_events` (`user.team_changed`) com quem executou, quando e um retrato de origem e destino: equipe e supervisor, com IDs e nomes. A mesma transação atualiza `leads.team_id` dos leads em operação e grava um `lead_event` `TEAM_CHANGED` para cada um (`metadata.movedLeads` na auditoria). Um trigger em `users`, verificado no COMMIT, impede que um vendedor mude de equipe deixando leads em operação para trás.

**Comissão não terá tabela própria**: é derivada de `sale_items.commission_cents` de vendas `ACTIVE`. O estorno muda o status da venda e a comissão deixa de contar automaticamente, sem risco de divergência. Se o cliente quiser controlar o **pagamento** de comissões ao vendedor, aí sim cria-se `commission_payouts`.

### Cursos (Fase 1)

| Função do serviço | Quem pode | O que retorna |
|---|---|---|
| `listActiveCourseOptions` | ADMIN, SUPERVISOR, SELLER (`courses:list`) | Somente `{ id, name, institutionName }` de cursos **ativos**. É a lista que leads e vendas vão usar |
| `listCoursesWithCost` / `getCourseWithCost` | ADMIN (`courses:viewCost`) | Ativos e inativos, com `scholarshipCostCents` |
| `createCourse` / `updateCourse` / `setCourseActive` | ADMIN (`courses:manage`) | Criação e edição de nome e custo; ativação/desativação. Sem exclusão |

- **Separação física:** o custo fica em `course_costs`. O tipo `CourseOption` não tem campo de custo, então nem por engano ele é serializado para outros perfis.
- **Auditoria:** `course.created`, `course.updated`, `course.cost_changed` (de/para, em centavos), `course.activated` e `course.deactivated`. Esses eventos têm `team_id = NULL`, então ficam de fora de uma futura auditoria por equipe para supervisores.
- **Dinheiro:** o valor digitado ("1.234,56") é convertido para centavos em [`src/lib/money.ts`](../src/lib/money.ts) sem ponto flutuante. O serviço só aceita inteiros entre 0 e R$ 1.000.000,00.
- **Tela** `/cursos`: exclusiva do ADMIN (404 para os demais). Busca, filtro de status, criar, editar e ativar/desativar.

### Leads (Fase 2)

Serviços em [`src/server/modules/leads/leads.service.ts`](../src/server/modules/leads/leads.service.ts); tela em [`src/app/(app)/leads`](../src/app/(app)/leads). O Kanban visual ainda não existe.

| Função do serviço | Quem pode | O que faz |
|---|---|---|
| `createLead` | SELLER (`leads:create`) | Cadastra na própria carteira e equipe: etapa `NEW`, ciclo 1 (`INITIAL`), evento `CREATED`. Curso de interesse ativo obrigatório |
| `listLeads` / `getLead` | todos (`leads:view`) + escopo | SELLER: próprios leads **ativos**; SUPERVISOR: equipe que lidera (inclui fila e Lixeira); ADMIN: todos. Fora do escopo → 404. `listLeads` é **paginada no banco** (`page`, `pageSize` 25/50/100; devolve `items`, `page`, `pageSize`, `total`, `totalPages`) com filtros de busca (nome ou telefone, formatado ou não), etapa, situação, curso, vendedor, equipe e fila (`queue`). O escopo entra no WHERE junto com os filtros e a contagem usa as mesmas condições. Cada item traz `queueReason` (sem responsável / Follow-up 3 vencido) |
| `editLead` | SELLER (próprios), SUPERVISOR (equipe), ADMIN (todos) — `leads:edit` + escopo | Edita **só** nome, telefone e curso de interesse (ativo). Lead na Lixeira: recusado (recuperar antes). Não mexe em responsável, equipe, etapa, prazos, situação nem ciclo. Só grava se algo mudou; evento `DETAILS_UPDATED` com de/para apenas dos campos alterados (curso com id, nome e instituição) |
| `getLeadTimeline` | quem enxerga o lead | Todos os eventos, de todos os ciclos, com nomes do ator, responsável, equipe e supervisor da época, de → para e o texto da observação |
| `addLeadNote` | SELLER responsável (`leads:addNote`) | Observação append-only no ciclo e etapa atuais. Em Negociação, renova o prazo (`negotiationDeadlineHours`) |
| `transferLead` | SUPERVISOR (própria equipe), ADMIN (qualquer equipe) | Troca o responsável. **Mantém etapa, entrada na etapa, prazo e ciclo.** Também é a transferência administrativa de um lead da fila |
| `redistributeLead` | SUPERVISOR, ADMIN | Só com **Follow-up 3 vencido**: encerra o ciclo (`REDISTRIBUTED`), abre ciclo `REWORK` para o vendedor escolhido, etapa `REWORK`, sem prazo |
| `trashLead` | SUPERVISOR, ADMIN | Lixeira: encerra o ciclo (`TRASHED`), preserva etapa, responsável (ou ausência dele) e telefone |
| `restoreLead` | SUPERVISOR (própria equipe), ADMIN | Recupera para o vendedor escolhido: novo ciclo `REWORK`, etapa `REWORK` |
| `moveLeadStage` | SELLER responsável (`leads:move`) + escopo | Muda a etapa conforme a máquina de estados (§4), com prazo e evento `STAGE_CHANGED` na mesma transação. Recusa: transição fora do mapa, Fechamento, Retrabalho, Follow-up 3 vencido e negociação vencida em outro lead |
| `getNegotiationBlock` | todos (`leads:view`) | Negociações vencidas do vendedor logado (contagem e leads), para o aviso persistente; `null` para quem não tem carteira |
| `countDecisionQueue` + `listLeads({ queue })` | SUPERVISOR (própria equipe), ADMIN (`leads:transfer`) | Fila de decisão: leads sem responsável (`UNASSIGNED`) e com Follow-up 3 vencido (`FOLLOW_UP_3_EXPIRED`), calculada por `stage_due_at`, sem job |
| `listLeadSellers` | SUPERVISOR (própria equipe), ADMIN | Vendedores no escopo, para filtros e para escolher o destino de transferência, redistribuição e recuperação |
| `listCourseFilterOptions` (cursos) | todos (`courses:list`) | Cursos ativos e inativos, **sem custo**, para filtrar leads antigos |

- **Telefone:** [`src/lib/phone.ts`](../src/lib/phone.ts) converte qualquer formato digitado ("(79) 99999-9999", "+55 79 99999-9999", "079 …") para o canônico (`5579999999999`) e formata para exibição. Guarda-se **só** o canônico: o formato digitado não carrega informação e uma segunda coluna poderia divergir. Um teste confere que a lista de DDDs do código é a mesma do `CHECK` do banco.
- **Duplicidade:** `LeadAlreadyExistsError` informa só o responsável e a equipe (ou que aguarda redistribuição, ou a mensagem da Lixeira) e não dá acesso ao lead. Vale no cadastro e na edição do telefone (mensagens próprias de cada operação). A unicidade vem da constraint `leads_phone_unique`: cadastros ou edições simultâneos com o mesmo telefone resultam em um único lead com ele; a consulta prévia só melhora a mensagem.
- **Vendedor desativado:** `setUserActive` deixa os leads em operação com `owner_id = NULL` (motivo `OWNER_DEACTIVATED`), na mesma equipe, mantendo etapa, prazo e ciclo, com um evento `UNASSIGNED` por lead. Reativar não os devolve. Um trigger em `users` garante que nenhuma desativação deixe lead em operação com vendedor inativo.
- **Inativar equipe:** recusado enquanto a equipe tiver leads em operação (ativos e não fechados), inclusive os sem responsável. Leads na Lixeira ou fechados não impedem.
- **Vendedor sem equipe:** `changeSellerTeam(…, { teamId: null })` é recusado enquanto houver leads em operação ("Este vendedor possui leads em aberto. Transfira os leads antes de removê-lo da equipe.").
- **Tela `/leads`:** abas *Leads*, *Fila de decisão* (com contagem por motivo) e *Lixeira* para SUPERVISOR/ADMIN; o SELLER vê só a própria carteira (sem colunas de responsável/equipe nem filtros de vendedor/equipe). Filtros, página, aba e lead aberto ficam **na URL** (`?q=&etapa=&curso=&vendedor=&equipe=&visao=&motivo=&pagina=&por=&lead=`). O detalhe abre num **drawer** com dados, avisos (aguardando supervisor, sem responsável, Lixeira), atualização do vendedor e **timeline montada só de `lead_events`/`lead_notes`**, agrupada por ciclo. Ações administrativas ficam num menu contextual e abrem modais (transferir, redistribuir, Lixeira com confirmação, recuperar). No celular, a tabela vira cards, os filtros abrem num painel inferior e o drawer ocupa a tela.
- **Actions** (`src/app/(app)/leads/actions.ts`): finas, com campos explícitos; erros de negócio (duplicidade etc.) voltam com a mensagem do serviço. O que a interface oferece vem de [`policy.ts`](../src/app/(app)/leads/policy.ts), mas a segurança é sempre do serviço.
- **Concorrência:** as mutações travam a linha do lead (`SELECT … FOR UPDATE`); o trigger do lead trava a linha do vendedor (`FOR SHARE`), então desativação/troca de equipe e atribuição de lead não se cruzam.

## 4. Kanban (estados)

As 9 colunas do Kanban misturam conceitos diferentes. Colocar todas num único enum permitiria estados impossíveis (ex.: lead na Lixeira com prazo de follow-up correndo). Modelo adotado, já com as decisões do cliente:

| Conceito | Modelagem | Valores |
|---|---|---|
| **Etapa do funil** | `leads.stage` (enum) | `NEW` (Lead Cadastrado), `NO_ANSWER`, `FOLLOW_UP_1`, `FOLLOW_UP_2`, `FOLLOW_UP_3`, `NEGOTIATION`, `CLOSED` (Fechamento), **`REWORK` (Retrabalho)** |
| **Situação do lead** | `leads.status` (enum) | `ACTIVE`, `TRASHED` (Lixeira). Fechado = etapa `CLOSED` (um status `WON` seria redundante) |
| **Responsável** | `leads.owner_id` | vendedor, ou `NULL` = fila do supervisor da equipe `team_id` (vendedor desativado) |
| **Ciclo de atendimento** | `lead_cycles`; ciclo atual = o ciclo **aberto** | `INITIAL` (ciclo 1) e `REWORK` (ciclos 2, 3…). Sem referência circular `leads → lead_cycles` |
| **Vencimentos** | **derivados** de `stage_due_at < agora` | Follow-up vencido, "aguardando supervisor" (FU3 vencido) e negociação vencida são calculados, não gravados como estado. Sem cron e sem estado desatualizado |

**Prazos:** "1 dia" = **24 horas corridas** (decisão do cliente). `stage_due_at = stage_entered_at + 24h` nos follow-ups; na negociação, `entrada ou última observação + 24h`. **Não Respondeu**, Lead Cadastrado e Retrabalho não têm prazo (o banco recusa prazo nessas etapas). A **transferência não reinicia** prazo. Tudo em `timestamptz`; os parâmetros ficam em `business-rules.ts` (`followUpDeadlineHours`, `negotiationDeadlineHours`).

**Fluxo de retrabalho (decisão do cliente):**

```
FU3 vencido -> volta para o Supervisor -> Lixeira (status = TRASHED)
                                       -> Redistribuir: escolhe novo vendedor
                                            -> fecha o ciclo atual (end_reason = REDISTRIBUTED)
                                            -> abre ciclo N+1 (kind = REWORK) para o novo vendedor
                                            -> stage = REWORK (coluna visível no Kanban)
                                            -> vendedor move: REWORK -> FU1 -> FU2 -> FU3
```

- **Retrabalho é etapa visível**, e o ciclo registra a tentativa. Cada `lead_event` aponta para o seu ciclo, então "FU1 do 1º atendimento" e "FU1 do retrabalho" ficam distinguíveis no histórico.
- **Lixeira** é status, não etapa: encerra o ciclo (`TRASHED`) e preserva a etapa, o responsável (ou a ausência dele, se veio da fila) e o telefone. A recuperação abre um ciclo `REWORK` e coloca o lead em `REWORK` para o vendedor escolhido.
- **Transferência × redistribuição:** transferir troca só o responsável (mesma etapa, prazo e ciclo); redistribuir é nova tentativa comercial (novo ciclo `REWORK`, etapa `REWORK`).
- **Fechamento** só é alcançado criando uma venda, na mesma transação. Não pode ser movido "à mão".
**Máquina de estados (decisão C32)** — `STAGE_TRANSITIONS` em [`src/lib/leads.ts`](../src/lib/leads.ts), validada por `moveLeadStage`:

| De | Para |
|---|---|
| Lead cadastrado | Não respondeu · Em negociação |
| Não respondeu | Follow-up 1 · Em negociação |
| Follow-up 1 | Follow-up 2 · Em negociação |
| Follow-up 2 | Follow-up 3 · Em negociação |
| Follow-up 3 | Em negociação (só se o FU3 **não** venceu) |
| Em negociação | Follow-up 1 |
| Retrabalho | Follow-up 1 |
| Fechamento | — (só com a venda, fase Vendas) |

- Sem volta arbitrária (FU3 → FU2, FU2 → FU1 etc. são recusados). Retrabalho nunca é destino manual: surge da redistribuição ou da recuperação da Lixeira. Fechamento nunca é destino manual.
- **Prazos (C33):** ao entrar em Follow-up 1/2/3 ou Em negociação, `stage_entered_at = agora` e `stage_due_at = agora + 24 h`; nas demais etapas, `stage_due_at = NULL`. Observação em Negociação: `stage_due_at = agora + 24 h`, sem mexer em `stage_entered_at`.
- **Follow-up 3 vencido (C27/C35):** somente leitura para o SELLER (não movimenta, não edita, não registra atualização; continua vendo dados, histórico e prazo). SUPERVISOR/ADMIN decidem: Redistribuir ou Lixeira.
- **Bloqueio por negociação vencida (C34):** se o SELLER tem alguma negociação ativa com `stage_due_at < agora`, `createLead` e `moveLeadStage` de **outros** leads respondem `NegotiationOverdueError` ("Você possui uma negociação vencida. Atualize-a…"). Login, consulta, drawer e histórico continuam liberados; a própria negociação vencida pode ser atualizada (o que renova o prazo) ou movimentada. O bloqueio some quando não há mais nenhuma vencida. Consulta pelo índice parcial `leads_negotiation_due_idx`.
- **Quem movimenta (decisão técnica, derivada de C5; confirmar na dúvida 26):** só o SELLER responsável (`leads:move`), pela regra C5 (só o vendedor tem carteira e follow-ups). SUPERVISOR e ADMIN acompanham o quadro e usam as ações administrativas.

**Tela `/kanban`:** colunas Lead cadastrado → Retrabalho; Fechamento aparece bloqueada ("indisponível até a fase de Vendas"); Lixeira continua na tela de Leads. Cada coluna consulta o banco com `listLeads` (escopo + filtros, prazo mais próximo primeiro) e mostra até 50 cards, com o total no cabeçalho e o link "ver todos na lista" quando há mais. Arrastar só realça e aceita os destinos permitidos (calculados no servidor); a mudança aparece na hora e, se a action recusar, o card volta e a mensagem de negócio aparece. Cada card tem também o menu "Mover para" (teclado e celular, onde o arrastar não funciona). O drawer é o mesmo da lista, com os botões "Mover para". O vendedor bloqueado vê o aviso persistente com a quantidade de negociações vencidas e o atalho para a mais antiga (na lista e no Kanban).

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
      equipes/ usuarios/ perfil/ auditoria/ cursos/ leads/
  components/
    ui/                      # Botão, campos, card, badge, tabela, diálogo, toast...
    layout/                  # AppShell, navegação por perfil, menu do usuário
  lib/                       # Utilitários puros (formatação, dinheiro, telefone, ActionState, cn)
  server/
    auth/                    # Senha, sessão, login, rate limit
    authz/                   # Actor, matriz RBAC, escopo
    config/business-rules.ts # Parâmetros de negócio centralizados
    db/                      # Schema, conexão (Postgres/PGlite), tipos, erros
    modules/<domínio>/       # Serviços: users, teams, audit, courses, leads (+ sales... nas fases)
    next/                    # Ponte Next.js ↔ serviços (sessão, runAction, orNotFound)
  proxy.ts                   # Redirect otimista para /login
database/migrations/         # SQLs executados manualmente no Supabase (fonte do schema)
drizzle/                     # Histórico das migrations anteriores (não aplicado)
scripts/                     # migrate, seed, reset
tests/                       # Vitest (authz, auth, módulos, banco)
```

Cada novo domínio entra como `src/server/modules/<domínio>/` (serviço + schemas) + `src/app/(app)/<rota>/` (páginas e actions) + testes em `tests/modules/`.

## 7. Fases de implementação

| Fase | Escopo | Seções do Documento Mestre |
|---|---|---|
| **0. Fundação** ✅ | Projeto, banco, migrations, auth, papéis, equipes, RBAC/escopo, auditoria, layout | §3, §4, §25 |
| **1. Cursos** ✅ | Cadastro de cursos, `course_costs` restrito ao admin, lista operacional sem custo | §10, §13 |
| **2. Leads** ✅ | Cadastro, edição, normalização e unicidade de telefone, transferência com histórico, `lead_events`/`lead_notes`, fila do supervisor, redistribuição, Lixeira e recuperação; tela operacional com busca, filtros, paginação, drawer e timeline | §5, §9, §19 |
| **3. Kanban + Follow-up** ✅ | Máquina de estados no backend, prazos, Follow-up 3 vencido somente leitura, quadro com arrastar validado | §6, §7 |
| **4. Negociação** ✅ | Observações renovando o prazo, vencimento e bloqueio do vendedor | §8 |
| 5. Retrabalho + Lixeira | ✅ entregue junto da fase 2 (serviços e telas) | §9 |
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
| C5 | **Supervisor não tem carteira comercial.** Só o SELLER tem leads, vendas, follow-ups, negociações e comissões | `leads:create` e `sales:create` = `SELLER`; trigger garante que `leads.owner_id` seja sempre um SELLER ✅ |
| C6 | **Parcelas**: só a estrutura (número, valor, vencimento, status, data de pagamento). Regras de geração ficam para a fase financeira | §3 |
| C7 | **ADMIN opera leads globalmente**: transfere, redistribui, manda para a Lixeira, recupera e escolhe o novo vendedor. A restrição de estorno (C1) vale só para Vendas | `leads:transfer/redistribute/trash/restore` incluem ADMIN |
| C8 | **Telefone**: só números brasileiros, DDD obrigatório, celular com 9º dígito. Qualquer formato de entrada vira um telefone canônico único (`(79) 99999-9999` = `+55 79 99999-9999`), com unicidade garantida no PostgreSQL ✅ `src/lib/phone.ts` + `leads_phone_unique` + `CHECK leads_phone_canonical` |
| C9 | **Duplicado ativo**: bloquear e informar só que já existe, o nome do responsável e a equipe. Nada de histórico, observações ou outros dados. Vale também ao editar o telefone | ✅ `LeadAlreadyExistsError` |
| C10 | **Duplicado na Lixeira**: bloquear; o lead é o MESMO registro. Mensagem: "Este lead já está cadastrado e encontra-se na Lixeira. Solicite ao supervisor ou administrador a recuperação." | ✅ `LeadAlreadyExistsError` |
| C11 | **Transferência**: SUPERVISOR só entre vendedores da própria equipe; ADMIN entre quaisquer equipes/vendedores. Tudo com histórico | ✅ `transferLead` |
| C12 | **Vendedor desativado** com leads abertos: nada é redistribuído automaticamente; os leads ficam **sem responsável** (`owner_id = NULL`), na equipe anterior, aguardando o supervisor. **Não** entram em Retrabalho. Histórico guarda vendedor anterior, equipe, supervisor, momento e motivo; a atribuição de outro vendedor é uma **transferência administrativa** (mantém etapa e ciclo). Mudança de equipe (sem desativação): os leads acompanham o vendedor (C4) | ✅ `unassignOpenLeadsOfSeller`, `transferLead` |
| C13 | **Curso por instituição**: o mesmo curso pode existir em instituições diferentes, com custos diferentes; unicidade = curso + instituição (`institution_name`, texto) | ✅ `courses.institution_name` + `courses_name_institution_unique` |
| C14 | **Banco oficial: Supabase** (só Postgres, sem Supabase Auth). Schema alterado apenas por SQLs manuais em `database/migrations` | [database/README.md](../database/README.md) |
| C15 | **Curso de interesse obrigatório**, um curso principal por lead. Não limita Vendas: a venda poderá ter vários cursos (itens) | `leads.interest_course_id NOT NULL` |
| C16 | **Telefone**: celular e fixo brasileiros válidos; guarda-se só o canônico em dígitos, formatado na interface; `UNIQUE(phone)` vale inclusive na Lixeira | `leads.phone`, §3 |
| C17 | **Transferência** = troca administrativa de responsável: mantém etapa, entrada na etapa, prazo e ciclo; não reinicia prazo. **Redistribuição** = nova tentativa comercial: novo vendedor, novo ciclo, etapa Retrabalho; usada após Follow-up 3 vencido e na recuperação da Lixeira | `transferLead`, `redistributeLead`, `restoreLead` |
| C18 | **Vendedor removido da equipe** (sem equipe) com leads abertos: a operação é recusada ("Este vendedor possui leads em aberto. Transfira os leads antes de removê-lo da equipe."). A desativação continua permitida (C12) | `changeSellerTeam` |
| C19 | **Lead da fila (vendedor desativado) pode ir para a Lixeira** pelo SUPERVISOR ou ADMIN sem atribuir vendedor antes | `trashLead` |
| C20 | **Não Respondeu** é manual e sem prazo. **Em Negociação**: prazo = entrada ou última observação + 24 h | `CHECK leads_stage_due_consistent`, `addLeadNote` |
| C21 | **Edição de lead**: nome, telefone e curso de interesse. SELLER edita os próprios; SUPERVISOR, os da equipe; ADMIN, todos. Lead na Lixeira não é editado. Mesmo telefone canônico e mesma regra de duplicidade do cadastro; curso ativo; evento `DETAILS_UPDATED` só com o que mudou | `editLead` |
| C22 | **Inativar equipe** só sem leads ativos (com ou sem responsável). Lixeira e leads encerrados não impedem | `updateTeam` |
| C23 | O **SELLER não vê os próprios leads na Lixeira** | `leadScope` em `leads.service.ts` |
| C24 | **Observações operacionais** só pelo SELLER responsável | `leads:addNote` = `SELLER` |
| C25 | **Redistribuição** só com Follow-up 3 vencido ou na recuperação da Lixeira; qualquer outra troca de responsável é transferência | `redistributeLead`, `restoreLead`, `transferLead` |
| C26 | Lead em **Fechamento** não é transferido nem enviado para a Lixeira | `transferLead`, `trashLead` |
| C27 | **Follow-up 3 vencido**: o SELLER continua vendo o lead, marcado "Aguardando decisão do supervisor", sem ação de movimentação; o supervisor o vê na fila e decide entre Redistribuir e Lixeira | `queueReason`, `leadActionsFor`, drawer |
| C28 | **Campos do lead** nesta fase: só nome, telefone e curso de interesse (sem e-mail, CPF, cidade etc.) | `leads` |
| C29 | **Data de cadastro** = `created_at` do banco; o SELLER não informa nem altera. Importação de leads antigos será um fluxo separado | `leads.created_at` |
| C30 | **SELLER não transfere lead**; SUPERVISOR transfere na própria equipe e ADMIN entre equipes | `leads:transfer` |
| C31 | **Listagem paginada no backend** (25 por padrão; 25, 50 ou 100), sem limite silencioso | `listLeads` |
| C32 | **Transições do Kanban** conforme a tabela da §4; sem volta arbitrária; Retrabalho e Fechamento nunca são destinos manuais | `STAGE_TRANSITIONS`, `moveLeadStage` |
| C33 | **Prazos**: entrada em FU1/FU2/FU3/Negociação = agora + 24 h; Lead cadastrado, Não respondeu e Retrabalho sem prazo; observação em Negociação renova para agora + 24 h sem mudar a entrada | `moveLeadStage`, `addLeadNote` |
| C34 | **Negociação vencida** bloqueia o vendedor de cadastrar leads e de movimentar outros leads; consulta liberada; some quando todas são atualizadas | `NegotiationOverdueError` |
| C35 | **Follow-up 3 vencido**: somente leitura para o vendedor (sem movimentar, editar ou registrar atualização) | `assertSellerMayChange` |

### Decisões técnicas

- **Política de senha**: mínimo de 8 caracteres; troca pelo próprio usuário exige a senha atual; o admin pode redefinir. Trocar ou redefinir a senha encerra todas as sessões. Não há recuperação por e-mail nesta fase (Documento Mestre §26).
- **Sessão**: 12 h (`SESSION_TTL_HOURS`), sem renovação deslizante.
- **Login**: mensagem genérica, tempo constante para e-mail inexistente, limite de 10 tentativas a cada 15 min por e-mail+IP (em memória; com múltiplas instâncias, mover para o Postgres).
- **Papel do usuário é imutável** depois de criado (trigger). Trocar papel tem efeitos em equipes, leads e vendas que ainda não foram definidos.
- **Desativar supervisor** exige antes definir outro supervisor para a equipe que ele lidera. **Inativar equipe** exige que ela não tenha vendedores ativos nem leads em operação (C22).
- **Primeiro administrador**: `npm run admin:create` (interativo, senha sem eco, nunca por argumento/arquivo/pipe). Usa o mesmo `hashPassword` e as mesmas validações da aplicação; recusa se já existir ADMIN ou se o e-mail já existir. O usuário e o evento `auth.admin_bootstrapped` (`actor_id = NULL`, metadata `{ source: "admin:create" }`) são gravados na mesma transação, sob um advisory lock contra execuções simultâneas.
- **Acesso negado em páginas** responde **404** (não revela existência). Não há `loading.tsx` envolvendo páginas com checagem de acesso, para que o status HTTP seja real.

## 9. Dúvidas em aberto

Resolvidas pelo cliente: C1–C35 (§8). As linhas abaixo mantêm a numeração original; as resolvidas foram removidas. Pendentes:

| # | Dúvida | Contexto | Padrão atual | Fase |
|---|---|---|---|---|
| 3 | Vendedor pode **exportar relatórios** (só os próprios dados)? | §4.4: "Não confirmado" | Negado | Relatórios |
| 4 | **Depois da venda**: o lead fica em Fechamento? Pode comprar de novo depois? Se a venda for **estornada**, volta para qual etapa? | Não definido | — | Vendas/Estorno |
| 5 | **Supervisor vê lucro/custo agregado do time?** | §17.2 × regra "não visualiza custos" | Custo e lucro só para admin | Dashboards |
| 6 | **"Por curso/aluno"**: uma venda pode ter cursos de **alunos diferentes**? | §14 e RA-03 | Item = curso; aluno = lead da venda | Vendas |
| 7 | **Custo de bolsa alterado**: vendas antigas mantêm o custo da época? | §26 | Proposta: sim (snapshot em `sale_items`) | Vendas |
| 11 | Formato e colunas de cada relatório | §26 | — | Relatórios |
| 26 | **SUPERVISOR ou ADMIN movimentam etapas** de um lead da equipe? | C5: só o vendedor tem carteira e follow-ups | Não (`leads:move` = SELLER) | Kanban |
| 27 | **Negociação vencida** deveria bloquear também **parcelas e certificados** quando existirem? | C34 cita só cadastro e movimentação de leads | Não bloqueia | Vendas |
