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
| `leads` | Pessoa/prospect | `phone_normalized` **UNIQUE** (E.164, só dígitos) — a constraint resolve corrida entre cadastros simultâneos; o serviço traduz a violação em "lead já existe, responsável: X". Campos: `owner_id`, `team_id`, `stage`, `status`, `stage_entered_at`, `stage_due_at`, `cycle` |
| `lead_interests` | Cursos de interesse (N:N lead↔curso) | Documento fala em "curso(s) de interesse" |
| `lead_events` | **Linha do tempo do lead** (append-only) | Um registro por fato: criação, mudança de etapa (de/para), transferência (responsável/equipe de/para), redistribuição, lixeira, recuperação, venda. Substitui `LeadAssignmentHistory` + `LeadStageHistory` sem redundância |
| `lead_notes` | Observações / atualizações de negociação | Imutáveis; nova observação nunca sobrescreve; `lead_events` referencia a nota |
| `courses` | Curso (nome, ativo) | Sem coluna de custo |
| `course_costs` | Custo de bolsa com vigência | Só ADMIN lê/escreve; histórico de alterações |
| `sales` | Cabeçalho: lead, vendedor, **equipe (snapshot)**, data, valor total, forma de pagamento, status (`ACTIVE`/`REVERSED`), dados do estorno (quem, quando, motivo) | Estorno = colunas na própria venda (1:1), sem tabela extra |
| `sale_items` | Um curso vendido | Snapshot de `scholarship_cost_cents` e `commission_cents` no momento da venda → relatórios históricos não mudam quando o custo/comissão mudar |
| `installments` | Parcelas | `UNIQUE(sale_id, number)`; soma = total (centavos, resto distribuído); status, pago em/por |
| `certificates` | Controle operacional | Vinculado a `sale_item` (aluno, curso, vendedor e data da venda derivam dele); conclusão, entrega, certificadora (texto) |
| `app_settings` | Parâmetros editáveis (ex.: comissão por curso) | Valor vigente copiado nos registros gerados |

**Comissão não terá tabela própria**: é derivada de `sale_items.commission_cents` de vendas `ACTIVE`. O estorno muda o status da venda e a comissão deixa de contar automaticamente, sem risco de divergência. Se o cliente quiser controlar o **pagamento** de comissões ao vendedor, aí sim cria-se `commission_payouts`.

## 4. Análise do Kanban (estados)

As 9 "etapas" listadas misturam três conceitos diferentes. Colocá-las num único enum permitiria estados impossíveis (ex.: lead na Lixeira com prazo de follow-up correndo). Proposta:

| Conceito | Modelagem | Valores |
|---|---|---|
| **Etapa do funil** (onde está no ciclo atual) | `leads.stage` (enum) | `NEW` (Lead Cadastrado), `NO_ANSWER`, `FOLLOW_UP_1`, `FOLLOW_UP_2`, `FOLLOW_UP_3`, `NEGOTIATION`, `CLOSED` (Fechamento) |
| **Situação do lead** (ciclo de vida) | `leads.status` (enum) | `ACTIVE`, `TRASHED` (Lixeira), `WON` |
| **Retrabalho** | atributo do **ciclo**, não etapa | `leads.cycle` (1, 2, 3…) + evento `REDISTRIBUTED` em `lead_events`. A coluna "Retrabalho" do Kanban mostra leads com `cycle > 1` ainda no início do novo ciclo |
| **Vencimentos** | **derivados** de `stage_due_at < agora` | Follow-up vencido, "aguardando supervisor" (FU3 vencido) e negociação vencida não são gravados como estado: são calculados. Isso dispensa cron e elimina estado desatualizado |

- **Lixeira** é status, não etapa: preserva a etapa e o responsável em que o lead estava, e a recuperação cria um novo ciclo.
- **Fechamento** só é alcançado criando uma venda, na mesma transação. Não pode ser movido "à mão".
- **Bloqueio por negociação vencida**: um guard de backend (`assertSellerNotBlocked`) roda antes de qualquer mutação de lead do vendedor e verifica, via SQL, se existe `stage = NEGOTIATION AND stage_due_at < agora` para ele.

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
| 1. Cursos | Cadastro de cursos, `course_costs` restrito ao admin | §10, §13 |
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

## 8. Decisões técnicas tomadas (não alteram regra de negócio)

- **Política de senha**: mínimo de 8 caracteres; troca pelo próprio usuário exige a senha atual; o admin pode redefinir. Trocar ou redefinir a senha encerra todas as sessões. Não há recuperação por e-mail nesta fase (Documento Mestre §26).
- **Sessão**: 12 h (`SESSION_TTL_HOURS`), sem renovação deslizante.
- **Login**: mensagem genérica, tempo constante para e-mail inexistente, limite de 10 tentativas a cada 15 min por e-mail+IP (em memória; com múltiplas instâncias, mover para o Postgres).
- **Papel do usuário é imutável** depois de criado (trigger). Trocar papel tem efeitos em equipes, leads e vendas que ainda não foram definidos.
- **Desativar supervisor** exige antes definir outro supervisor para a equipe que ele lidera. **Inativar equipe** exige que ela não tenha vendedores ativos.
- **Acesso negado em páginas** responde **404** (não revela existência). Não há `loading.tsx` envolvendo páginas com checagem de acesso, para que o status HTTP seja real.

## 9. Dúvidas em aberto

Nenhuma bloqueia a fundação. Cada uma deve ser respondida antes da fase indicada.

| # | Dúvida | Divergência / contexto | Padrão atual no código | Fase |
|---|---|---|---|---|
| 1 | **Quem pode estornar venda?** | O prompt diz "apenas supervisor"; a matriz §4.4 do Documento Mestre dá ao admin "Administração global" | Só `SUPERVISOR` | 8 |
| 2 | **O admin executa os fluxos operacionais do supervisor** (redistribuir, lixeira, recuperar)? | §26 recomenda permissão global, "de forma consciente" | Admin incluído em transferir/redistribuir/lixeira/recuperar (§4.1 e §4.4 confirmam) | 3–5 |
| 3 | Vendedor pode **transferir lead**? | §4.4: "Não confirmado" | Negado | 2 |
| 4 | Vendedor pode **exportar relatórios** (só os próprios dados)? | §4.4: "Não confirmado"; §20 cita só supervisor/admin | Negado | 12 |
| 5 | **"1 dia" de prazo**: 24 h corridas a partir da movimentação, ou até o fim do dia seguinte (calendário, America/Sao_Paulo)? | §7 diz "prazo de 1 dia"; §8 diz "no dia seguinte sem atualização" | Centralizado em `business-rules.ts`, sem uso ainda | 3–4 |
| 6 | **Retrabalho**: o lead fica numa coluna "Retrabalho" até o novo vendedor movê-lo para FU1, ou entra direto em FU1? Quando começa a contar o prazo do FU1? | §6 trata Retrabalho como etapa; §7 diz "inicia novamente FU1" | — | 5 |
| 7 | **Depois da venda**: o lead fica em "Fechamento" para sempre? Pode comprar de novo depois? Se a venda for **estornada**, o lead volta para qual etapa? | Não definido | — | 6, 8 |
| 8 | **Vendedor muda de equipe**: os leads em aberto dele vão junto (o novo supervisor passa a vê-los) ou ficam na equipe antiga para redistribuição? | §3 só diz que o admin pode trocar | Vendas guardarão a equipe da época (snapshot) | 2 |
| 9 | **Supervisor vê lucro/custo agregado do time?** | §17.2: "visibilidade financeira… sem exposição do custo unitário"; o prompt diz "não pode visualizar custos" | Custo e lucro só para admin | 6, 10 |
| 10 | **Supervisor também vende** (tem leads e vendas próprios e entra no ranking de vendedores)? | §4.4: "Ver próprios leads/vendas: Supervisor Sim" | Matriz permite `leads:create`/`sales:create` ao supervisor; ranking a definir | 2, 9 |
| 11 | **"Por curso/aluno"**: uma venda pode incluir cursos de **alunos diferentes** (ex.: família)? Se sim, cada item precisa do nome do aluno (afeta Certificados) | §14 e RA-03 | Item = curso; aluno = lead da venda | 6 |
| 12 | **Custo de bolsa alterado**: vendas antigas mantêm o custo da época? | §26 lista como pendente | Proposta: sim (snapshot em `sale_items`) | 1, 6 |
| 13 | **Pix**: registrado como pago na data da venda (uma "parcela" paga)? Existe Pix parcelado/agendado? | §12.1 só diz "Pix" | Proposta: 1 parcela, paga na data da venda | 7 |
| 14 | **Parcelas do cartão**: datas de vencimento (mensal a partir da venda?), qual parcela absorve o resto de centavos, edição de vencimento, atraso, baixa parcial | §12.2 e §26 dizem explicitamente que não está definido | — | 7 |
| 15 | **Negociação vencida bloqueia o quê exatamente?** O vendedor ainda pode registrar venda de outro lead, marcar parcela paga e operar certificados? | §8: "cadastrar novos leads ou movimentar outras frentes do Kanban" | Proposta: bloquear criação de lead e movimentação de outros leads; parcelas e certificados liberados | 4 |
| 16 | **FU3 vencido**: o lead continua com o mesmo responsável (só some da fila dele) até o supervisor decidir? | §7 | Proposta: mantém o responsável e fica marcado como "aguardando supervisor" | 3 |
| 17 | Campos adicionais do lead (e-mail, CPF, cidade)? | §26 | Só os campos mínimos | 2 |
| 18 | Formato e colunas de cada relatório | §26 | — | 12 |
