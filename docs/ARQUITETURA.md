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
| UI | **Tailwind CSS 4** + componentes próprios + **lucide-react** | Identidade visual do Colégio Técnico Orienta (azul-marinho #021C37 e creme #FADEB1; marca em `src/assets/brand`, componentes em `src/components/brand`), sem kit pesado. Gráficos (fase de dashboards): Recharts. |
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

### Vendas (migration 003; backend das Etapas 3a e 3b)

| Tabela | Papel | Regras no banco |
|---|---|---|
| `sales` | Venda de um lead: vendedor responsável (sempre SELLER), `team_id` = equipe dele quando passou a ser o responsável (**registro histórico**; desde a C50 não define escopo nem agrupamento gerencial), `supervisor_id` histórico, `sale_date` (dia comercial), `total_cents > 0`, `PIX` (à vista) ou `CARD` (parcelas ≥ 1, sem máximo), `status` `ACTIVE`/`REVERSED` | lead e autor imutáveis; responsável SELLER ativo com equipe, equipe/supervisor = os atuais dele na criação e na troca de responsável; criar e mudar status só em READ COMMITTED; lead tem venda válida ⇔ lead ativo em Fechamento (no COMMIT); sem DELETE |
| `sale_items` | Uma ocorrência de curso vendido (o mesmo curso pode repetir) com **preço de venda próprio** (`price_cents > 0`, migration 004) e snapshots de custo de bolsa e de comissão | curso ativo; custo = o vigente em `course_costs`; nunca apagado: só remoção lógica ou correção de preço (custo e comissão imutáveis); pelo menos um item atual por venda e **`sales.total_cents` = soma dos preços dos itens atuais** (no COMMIT) |
| `sale_events` | Histórico da venda (append-only): `CREATED`, `UPDATED`, `REVERSED`, `REACTIVATED` | `metadata`, `occurred_at` e `txid` calculados pelo banco; o histórico precisa corresponder exatamente à mudança líquida da transação (no COMMIT); motivo obrigatório em estorno/reativação |

`lead_events` ganhou `sale_id` (eventos `SALE_*`) e `lead_cycle_kind` ganhou `REOPENED` (novo ciclo quando a última venda válida é estornada).

Serviço em [`src/server/modules/sales/sales.service.ts`](../src/server/modules/sales/sales.service.ts):

| Função | Quem pode | O que faz |
|---|---|---|
| `createSale` | SELLER, SUPERVISOR, ADMIN (`sales:create`) + escopo do lead | Venda para lead ATIVO em qualquer etapa (C37). Itens `{courseId, priceCents}`; o total é a soma, calculada no servidor (nunca enviada pelo cliente). Responsável: SELLER escolhe a si ou colega ativo da própria equipe; SUPERVISOR/ADMIN, qualquer vendedor ativo (C36); nunca de equipe inativa (C38). Data: hoje no fuso do negócio; só o ADMIN informa outra (`sales:setDate`). Snapshots de custo (`course_costs`) e comissão (`business-rules.ts`) vêm do backend. Fecha o lead (ciclo `WON`, Fechamento, responsável = vendedor da venda) ou o mantém em Fechamento; grava `SALE_CREATED` e `sale_events` `CREATED`. Idempotente pelo `requestId` (vira o id da venda) |
| `listSales` / `getSale` / `getSaleHistory` | todos (`sales:view`) + escopo | SELLER: vendas de que é responsável; SUPERVISOR: vendas cujo responsável está **hoje** na equipe que lidera (`users.team_id`, não `sales.team_id`; C36, mantida pela C50); ADMIN: todas. **Sem custo de bolsa**; o histórico sai sem `costSnapshotCents` e sem controle técnico |
| `getSaleWithCost` | ADMIN (`finance:viewCostAndProfit`) | Itens com o custo de bolsa (snapshot) e o total de custo |
| `updateSale` | SELLER (só **incluir** itens, com preço, em venda válida), SUPERVISOR (+ remover itens, corrigir preços, pagamento, parcelas, responsável, venda estornada), ADMIN (+ data) — `sales:edit/editFinancial/changeSeller/editReversed/setDate` + escopo | `addItems` (preço informado, snapshots vigentes), `removeItemIds` (remoção lógica) e `repriceItems` (correção no próprio item: custo e comissão ficam iguais). O total é sempre recalculado como a soma dos itens atuais. Troca de responsável: vendedor ativo de equipe ativa; a venda vai para a equipe atual dele e o supervisor dela; se a venda é válida, o lead acompanha (`SALE_SELLER_CHANGED`). Lead da venda imutável. O banco grava `UPDATED` com antes/depois |
| `reverseSale` | SUPERVISOR, ADMIN (`sales:reverse`) + escopo | Motivo obrigatório. Venda continua existindo (itens e snapshots), fora de faturamento/comissão/ranking. Com outra venda válida: lead continua em Fechamento, mesmo responsável. Última venda válida: Lead cadastrado em novo ciclo `REOPENED`, com o responsável atual (se ativo e da equipe do lead) ou na fila do supervisor (se inativo) — C39 |
| `reactivateSale` | SUPERVISOR, ADMIN (`sales:reactivate`) + escopo | Motivo obrigatório. Exige responsável ativo de equipe ativa (senão, trocar o responsável antes) e lead fora da Lixeira (recuperar antes; nada é automático). Venda volta a ser válida; lead vai (ou continua) em Fechamento com o responsável da venda (`SALE_REACTIVATED`) |

- **Travas:** usuários (ator, responsável atual do lead, vendedor escolhido) → equipes → lead (`lockLeadForChange`) → cursos → custos → venda → itens, numa transação `runTransaction` (READ COMMITTED + nova tentativa em deadlock).
- **Idempotência da criação:** o formulário gera um UUID por operação (`requestId`), que vira `sales.id`. A mesma solicitação repetida (inclusive depois de resposta perdida) devolve a venda já gravada (`replayed: true`), conferida contra o retrato `CREATED` do banco; o mesmo id com outros dados ou outro autor é recusado.
- **Concorrência das alterações:** `getSale` devolve `version` (id do último `sale_events` da venda — toda alteração confirmada gera um evento, o banco exige). `updateSale`, `reverseSale` e `reactivateSale` recebem `expectedVersion` e, com a venda travada, recusam com conflito se ela mudou: sem atualização perdida e sem repetir uma operação reenviada depois de concluída (o reenvio recebe conflito, não "sucesso repetido" — para isso seria preciso uma chave de idempotência gravada no banco).
- **Travas das alterações:** usuários (ator, responsável do lead, responsável da venda, novo responsável) → equipes → lead (`lockLeadForSale`, sem escopo de lead: a autorização é pelo escopo da venda) → venda (`FOR UPDATE OF sales`) → cursos/custos → itens.

**Telas (Etapa 3c)** em [`src/app/(app)/vendas/`](../src/app/(app)/vendas/): lista paginada no banco com filtros na URL (lead, situação, pagamento, período; responsável para SUPERVISOR/ADMIN; equipe para ADMIN), registro (`/vendas/nova`, a partir do lead), detalhe com histórico e edição. Actions finas em `actions.ts`, só com campos explícitos; o total nunca é lido do formulário (os preços em reais viram centavos por `parseBRLToCents`, sem ponto flutuante). O `requestId` é gerado ao abrir o formulário e reenviado igual em toda tentativa; o rascunho (dados + `requestId`) fica no `sessionStorage` da aba, ligado ao usuário e ao lead, vale 24 h (decisão técnica provisória) e é apagado só no sucesso confirmado — um F5 ou uma resposta perdida mantém a mesma chave, e uma nova chave só nasce em "Começar nova venda" (com confirmação se a tentativa já foi enviada). Isso vale só para a aba: outra aba ou outro dispositivo é outra tentativa. `REQUEST_ID_REUSED` não é sucesso: a tela pede para conferir as vendas do lead; se a venda registrada ficar fora do acesso do ator (ex.: atribuída a um colega), a resposta é genérica, sem dados dela. Edição, estorno e reativação levam a `version` lida na página: em conflito (ou resposta perdida no estorno/reativação) a tela pede para atualizar a venda, recarrega dados e versão antes de nova tentativa e nunca reenvia sozinha. Custo e lucro só aparecem no detalhe para quem tem `finance:viewCostAndProfit`. No Lead: botão "Registrar venda", vendas do lead e link "Ver venda" nos eventos `SALE_*`; no Kanban, coluna Fechamento (só recebe leads pela venda) e "Registrar venda" nos cards. **Estornos (§15):** aba "Estornos" na tela de Vendas = a mesma listagem e o mesmo escopo de `listSales`, filtrada por vendas estornadas, com data/hora, autor e motivo do **último** estorno de cada venda (o evento `REVERSED` de maior id em `sale_events`; estornos anteriores a uma reativação continuam no histórico do detalhe). Nenhuma permissão nova.

### Ranking (§16; sem tabela própria)

`getRanking` em [`src/server/modules/ranking/`](../src/server/modules/ranking/) (`ranking:view`), só leitura, calculado no banco a partir das vendas **válidas** (`status = ACTIVE`) com `sale_date` no período — estornadas não contam. Critério: quantidade de vendas ou valor faturado (soma de `total_cents`). Vendedores agrupados por `sales.seller_id`; equipes pela equipe **atual** do vendedor responsável (`users.team_id`, C50), inclusive as vendas anteriores a uma transferência — `sales.team_id` fica só como registro histórico. Vendas de vendedor sem equipe atual formam o grupo **"Sem equipe"** (`id = null`), só na visão do ADMIN. Participa quem tem venda válida no período (C43); empate no critério divide a posição, sem desempate (C44). Visibilidade aplicada no serviço (C42): ADMIN vê vendedores e equipes; SUPERVISOR vê os vendedores atualmente na equipe que lidera, com as vendas históricas deles, e o ranking de todas as equipes (sem o grupo "Sem equipe", que não está no escopo de nenhum supervisor — decisão técnica derivada da C50); SELLER recebe só `{posição, total, empate, próprias vendas e faturamento}` do ranking geral de vendedores — nenhum nome ou número de colega sai do servidor, e a visão de equipes é recusada. Tela `/ranking`: visão, critério e período na URL (mês atual, outro mês ou intervalo De/Até; intervalo incompleto ou invertido volta ao mês com aviso); regras puras em [`src/lib/ranking.ts`](../src/lib/ranking.ts).

### Dashboard comercial (§17; sem tabela própria)

Página inicial (`/`), com período na URL (o mesmo parser do Ranking: mês atual, outro mês ou intervalo). Serviços: `getSalesIndicators` e `getMonthlyComparison` em [`src/server/modules/dashboard/`](../src/server/modules/dashboard/), `getLeadIndicators` em `leads.service.ts`, posições e desempenho via `getRanking`. Regras puras em [`src/lib/dashboard.ts`](../src/lib/dashboard.ts).

- **Vendas (C45/C46):** só vendas válidas, pela `sale_date`. Faturamento = soma de `sales.total_cents` (valor vendido, não parcelas recebidas). Comissão = soma de `commission_snapshot_cents` dos itens atuais (mesma regra do detalhe da venda, §14). Custo = soma de `cost_snapshot_cents` dos itens atuais e lucro = faturamento − custo (§13) — **somente ADMIN** (`finance:viewCostAndProfit`); para os demais o custo nem é consultado e o retorno não tem `finance`. Escopo (C50): SELLER as vendas de que é responsável; SUPERVISOR as vendas dos vendedores **atualmente** na equipe que lidera (`users.team_id`), inclusive as anteriores à transferência; ADMIN todas, inclusive de vendedores sem equipe atual. O desempenho por equipe (ADMIN) vem do Ranking, agrupado pela equipe atual do vendedor, com o grupo "Sem equipe".
- **Leads (C47):** três números separados — leads cadastrados no período (data de cadastro no fuso do negócio), carteira atual por etapa (leads ativos agora, independe do período) e alertas (follow-ups e negociações com prazo vencido; para SUPERVISOR/ADMIN também a fila de decisão de `countDecisionQueue`). Escopo de leitura = o de `listLeads` (SELLER os próprios ativos; SUPERVISOR os da equipe **atual** do lead; ADMIN todos). Conversão = leads cadastrados no período com pelo menos uma venda válida (em qualquer data; cada lead conta uma vez) ÷ leads cadastrados no período que **não estão hoje na Lixeira** (`conversionBase`, #28) × 100; sem leads elegíveis → "Indisponível". Lixeira (C49): fora da carteira, dos alertas e da fila; nos leads do período ela entra para quem a enxerga (SUPERVISOR/ADMIN), com a quantidade identificada (`trashedInPeriod`). Lead na Lixeira nunca tem venda válida (o banco exige lead ativo em Fechamento e a Lixeira recusa Fechamento), então só afetaria o denominador — e a #28 o tira de lá: o denominador conta só leads fora da Lixeira, para todos os perfis (assim a conversão da equipe coincide com a dos vendedores quando a população é a mesma).
- **Comparação mês a mês (C48, ADMIN):** os 12 meses até o mês atual (o atual em andamento), com vendas, faturamento, custo e lucro e a variação % sobre o mês anterior; mês anterior zerado (ou lucro anterior ≤ 0) → variação "Indisponível".

### Certificados (§18; migration 005)

| Tabela | Papel | Regras no banco |
|---|---|---|
| `certificates` | Um certificado por **item de venda** (`sale_item_id` único; o mesmo curso repetido na venda são itens distintos): `completed_on` (conclusão), `delivered_on` (entrega), `certifier` (certificadora, texto livre), `created_by`/`created_at` | entrega ≥ conclusão; certificadora não vazia (até 200 caracteres); item, autor e momento do registro imutáveis; sem DELETE/TRUNCATE; RLS + `REVOKE` |

Aluno (nome do lead), curso, vendedor e data da venda **não** são copiados: vêm do item, da venda e do lead. Serviço em [`src/server/modules/certificates/certificates.service.ts`](../src/server/modules/certificates/certificates.service.ts), todos com `certificates:operate` (ADMIN, SUPERVISOR, SELLER) e o escopo das vendas (C50: SELLER as vendas de que é responsável; SUPERVISOR as dos vendedores atualmente na equipe que lidera; ADMIN todas; fora dele → 404):

| Função | O que faz |
|---|---|
| `registerCertificate` | Registra conclusão, entrega e certificadora de uma vez (C51), só para item **atual** de venda **válida** (C51). Datas não futuras (fuso do negócio) e entrega ≥ conclusão. Trava a venda (`FOR SHARE`) antes de conferir, então estorno e remoção de item concorrentes esperam. Segundo certificado do mesmo item → conflito. Auditoria `certificate.created` em `audit_events` (com a equipe atual do vendedor) na mesma transação |
| `listCertificates` | Paginada no banco; busca pelo nome do aluno e período pela data de **conclusão** ou de **entrega** (padrão); devolve o total de certificados e de alunos distintos nos filtros. Vendedor = responsável **atual** da venda (C51); mostra também a situação atual da venda e do item |
| `getSaleItemCertificates` | Certificados dos itens atuais de uma venda no escopo (detalhe da venda) |

Telas: `/certificados` (filtros na URL, contagens, tabela/cards, paginação) e, no detalhe da venda, a coluna **Certificado** em cada curso, com "Registrar certificado" nos itens de venda válida ainda sem certificado. Não há edição nem exclusão. Pendentes, sem comportamento inventado: o que acontece com o certificado se a venda for estornada ou o item removido depois do registro (nada é alterado; a lista só sinaliza "Venda estornada"/"Curso removido da venda"), correção/desfazer de certificado e certificados de vendas anteriores ao CRM.

### Parcelas (§12; migration 006)

| Tabela | Papel | Regras no banco |
|---|---|---|
| `installments` | Parcelas do **cartão**: `number`, `amount_cents`, `due_date`, `status` (`OPEN`/`PAID`/`CANCELED`), `paid_at`/`paid_by`, `replaced_at` (cronograma substituído, histórico) | cronograma atual (`replaced_at` NULL) conferido no COMMIT contra a venda: Pix sem parcelas; cartão com exatamente `installment_count` parcelas, números 1..N, vencimento = `sale_date + n meses`, valor = total ÷ N com o resto na 1ª, soma = total; venda válida sem parcela cancelada e estornada sem parcela em aberto. Transições: OPEN → PAID, OPEN ↔ CANCELED, → substituída; paga e substituída imutáveis; venda, número, valor e vencimento imutáveis; `paid_at`/`replaced_at`/`created_at` do banco; sem DELETE/TRUNCATE; RLS + `REVOKE` |

Regra pura em [`src/lib/installments.ts`](../src/lib/installments.ts) (a mesma que o banco confere); serviço em [`src/server/modules/installments/installments.service.ts`](../src/server/modules/installments/installments.service.ts). O cronograma é mantido **dentro das transações de venda** (`sales.service`, com a venda já travada `FOR UPDATE`): criado em `createSale`; em `updateSale`, mudança de total (inclusive inclusão/remoção/correção de itens), forma de pagamento, quantidade de parcelas ou data → cronograma refeito (o anterior fica cancelado com `replaced_at`), ou a alteração inteira é recusada se houver parcela paga; troca de responsável não mexe nas parcelas; `reverseSale` cancela as em aberto (pagas continuam pagas); `reactivateSale` reabre as canceladas do cronograma atual (venda estornada editada sem parcela paga ganha cronograma novo já cancelado, que a reativação reabre).

| Função | Quem pode | O que faz |
|---|---|---|
| `markInstallmentPaid` | ADMIN, SUPERVISOR, SELLER (`installments:markPaid`) + escopo C50 | Marca parcela **em aberto** do cronograma atual como paga (data/hora do servidor e autor); trava a venda (`FOR SHARE`) e depois a parcela (`FOR UPDATE`), a mesma ordem das operações de venda; segunda vez → conflito. Auditoria `installment.paid` em `audit_events` (com a equipe atual do vendedor) |
| `listInstallments` | idem | Só o cronograma atual; paginada no banco; filtros: situação (em aberto, **vencidas** = em aberto com vencimento antes de hoje, pagas, canceladas), período de vencimento e nome do lead; resumo com quantidade e soma dos valores |
| `getSaleInstallments` | idem | Cronograma atual de uma venda (detalhe da venda) |

Telas: `/parcelas` e o card **Parcelas** no detalhe de vendas no cartão, ambos com "Marcar como paga" (confirmação). Faturamento, comissão, ranking e dashboard continuam pela venda válida e pela data da venda (C45), sem depender de recebimentos. **Ordem de implantação:** com a 006 aplicada, a versão anterior da aplicação não consegue registrar vendas no cartão (o banco exige o cronograma); o código de Parcelas precisa ir junto. Pendentes (não implementados): edição manual de vencimento, baixa parcial, desfazer pagamento, informar uma data de pagamento diferente da do registro e tratamento de atraso além da sinalização "Vencida".

### Relatórios (§20; sem tabela própria)

`buildReport` em [`src/server/modules/reports/reports.service.ts`](../src/server/modules/reports/reports.service.ts), só com `reports:export` (ADMIN, SUPERVISOR; SELLER negado — dúvida #3). **Não refaz escopo nem cálculo**: cada relatório chama o serviço oficial do módulo e percorre todas as páginas dele (mesmo escopo e filtros da tela), com teto técnico de 10.000 linhas por arquivo (acima disso, pede filtros mais estreitos).

| Relatório | Fonte | Período |
|---|---|---|
| Leads | `listLeads` (escopo de leitura de leads; filtro novo `createdFrom/createdTo` pelo dia de cadastro no fuso do negócio, a mesma expressão do Dashboard) | Data de cadastro |
| Vendas | `listSales` (escopo C50, filtros da lista); custo das bolsas e lucro (total − custo, §13) só para `finance:viewCostAndProfit`, por `getSalesCostTotals` (mesma soma de `getSaleWithCost`) | Data da venda |
| Itens vendidos | `listSaleItemsForReport` (itens atuais; mesmas condições de `listSales`, extraídas em `saleListConditions`); custo e lucro do item só para o ADMIN | Data da venda |
| Comissões | Itens atuais das vendas **válidas**, somados por vendedor responsável — a regra da comissão do Dashboard (§14, C45) | Data da venda |
| Desempenho | `getRanking` (vendedores ou equipes, quantidade ou faturamento; C42–C44 e C50, inclusive "Sem equipe" só para o ADMIN) | Data da venda (obrigatório) |
| Parcelas | `listInstallments` (cronograma atual; "Vencida" como na tela) | Vencimento |
| Certificados | `listCertificates` | Conclusão ou entrega |

Tela `/relatorios` (um formulário por relatório) e download em `/relatorios/exportar` (Route Handler: revalida a sessão, só repassa os filtros conhecidos e o serviço valida cada relatório com `z.strictObject`; erro de negócio volta para a tela com a mensagem). Formato (decisão técnica, §26 e dúvida #11): **CSV para Excel pt-BR**, sem dependência nova — UTF-8 com BOM, separador `;`, decimal com vírgula, CRLF; textos iniciados por `= + - @` recebem apóstrofo (sem injeção de fórmula). A coluna "Equipe na venda" é o registro histórico (`sales.team_id`); escopo e agrupamento seguem a C50.

### Planejado (próximas fases)

| Entidade | Responsabilidade | Observações de modelagem |
|---|---|---|
| `app_settings` | Parâmetros editáveis (ex.: comissão por curso) | O valor vigente é copiado nos registros gerados |

### Equipe "da época" × equipe atual

Decisão do cliente: quando o vendedor muda de equipe, **seus leads em aberto o acompanham**, mas **vendas e eventos passados ficam com a equipe em que ocorreram**.

- `users.team_id` e `leads.team_id` = situação **atual**: definem o escopo operacional (o novo supervisor passa a ver os leads; o anterior deixa de ver).
- `sales.team_id` / `sales.supervisor_id` e `lead_events.team_id` = **retrato do momento**, nunca reescritos. Os R$ 20.000 vendidos por João na Equipe A em setembro continuam **registrados** na Equipe A.
- **Escopo e agrupamento gerencial (C50, substitui o critério anterior de Dashboard e Ranking):** quem vê e como se agrupa segue a equipe **atual** do vendedor responsável. Se João passa para a Equipe B, o supervisor da B passa a ver e somar aqueles R$ 20.000 na B; o da A deixa de vê-los. O registro histórico (`sales.team_id`) e o histórico da transferência não mudam.
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
| `createLead` | SELLER, SUPERVISOR, ADMIN (`leads:create`, C41) | SELLER cadastra na própria carteira e equipe; SUPERVISOR/ADMIN informam o vendedor responsável (`sellerId`), com as regras da transferência: SUPERVISOR só da equipe que lidera, ADMIN qualquer um, sempre vendedor ativo de equipe ativa; a equipe do lead é a do vendedor e o autor (`created_by`, ator do evento) é quem cadastrou. Etapa `NEW`, ciclo 1 (`INITIAL`), evento `CREATED`. Curso de interesse ativo obrigatório; duplicidade e Lixeira como antes |
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
- **`sale_events`** é a trilha oficial da venda (criação, alterações, estorno, reativação), com o conteúdo calculado e conferido pelo PostgreSQL (migration 003). Os fatos de venda que afetam o lead também entram em `lead_events` (`SALE_*`). Vendas **não** são duplicadas em `audit_events`.
- **`audit_events`** (central, append-only) cobre o restante: autenticação, usuários, equipes, custos de curso, parcelas, certificados e mudanças financeiras. Guarda `team_id` para permitir auditoria por equipe ao supervisor.
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
| 6. Vendas | **3a ✅** registro e consultas. **3b ✅** edição, estorno e reativação (backend). **3c ✅** telas e integração com Leads/Kanban | §11, §13, §14, §15 |
| 7. Pagamentos e parcelas ✅ | Migration 006, cronograma do cartão mantido com a venda, pagamento, lista com situação e período (C52) | §12 |
| 8. Estorno ✅ | Estorno/reativação com motivo (Etapa 3b) e aba **Estornos** em Vendas. Saída do faturamento, lucro e comissão do período: verificar quando existirem Dashboards/Comissões | §15 |
| 9. Ranking ✅ | Quantidade × faturamento, vendedores × equipes, mês/intervalo; visibilidade C42–C44 | §16 |
| 10. Dashboards ✅ | Vendas, faturamento, comissão, custo/lucro (ADMIN), leads do período, carteira por etapa, conversão, alertas, desempenho por vendedor/equipe, 12 meses (ADMIN) — C45–C48 | §17 |
| 11. Certificados ✅ | Controle operacional: migration 005, registro por item, lista com período e contagem (C51) | §18 |
| 12. Relatórios ✅ | Exportação CSV (Excel) de leads, vendas, itens, comissões, desempenho, parcelas e certificados, pelos serviços de cada módulo | §20 |
| 13. Endurecimento | E2E, testes de cálculo, revisão de segurança | §24 |

## 8. Decisões

### Decisões do cliente (corrigem ou complementam o Documento Mestre)

| # | Decisão | Onde está refletida |
|---|---|---|
| C1 | ~~**Estorno só pelo SUPERVISOR.** O ADMIN tem visão global, mas não executa automaticamente as ações operacionais~~ — **substituída pela C36** (o Documento Mestre §4.4 já dava "Sim" ao administrador) | — |
| C2 | **"1 dia" = 24 horas corridas** desde a entrada na etapa ou a última atualização válida | `business-rules.ts`, §4 |
| C3 | **Retrabalho é etapa visível do Kanban**, e o histórico distingue os ciclos de follow-up | `stage = REWORK` + `lead_cycles`, §4 |
| C4 | **Vendedor que muda de equipe leva os leads em aberto**; vendas e eventos passados ficam com a equipe da época. *Atualizada pela C50:* a equipe da época continua gravada como histórico (`sales.team_id`), mas não define mais escopo nem agrupamento gerencial | §3 "Equipe da época × equipe atual"; auditoria da troca com retrato de origem e destino (implementado) |
| C5 | **Supervisor não tem carteira comercial.** Só o SELLER tem leads, vendas, follow-ups, negociações e comissões: o **responsável** de lead e de venda é sempre um SELLER. *Atualizada pela C36:* SUPERVISOR e ADMIN também **registram** vendas, escolhendo o vendedor responsável. *Atualizada pela C41:* também **cadastram** leads, escolhendo o vendedor responsável | triggers garantem que `leads.owner_id` e `sales.seller_id` sejam sempre SELLER ✅ |
| C6 | **Parcelas**: só a estrutura (número, valor, vencimento, status, data de pagamento). Regras de geração ficam para a fase financeira. *Complementada pela C52* | §3 "Parcelas" |
| C7 | **ADMIN opera leads globalmente**: transfere, redistribui, manda para a Lixeira, recupera e escolhe o novo vendedor. *(A restrição de estorno da C1 foi substituída pela C36: o ADMIN também estorna e reativa vendas.)* | `leads:transfer/redistribute/trash/restore` incluem ADMIN |
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
| C36 | **Permissões de Vendas** (substitui a C1): SELLER, SUPERVISOR e ADMIN registram vendas no próprio escopo. SELLER atribui a si ou a vendedor ativo da própria equipe; SUPERVISOR e ADMIN, a qualquer vendedor ativo. Consulta: SELLER as próprias; SUPERVISOR as dos vendedores **atualmente** na sua equipe (critério estendido a Dashboard, Ranking e futuros módulos pela C50); ADMIN todas. Estorno e reativação (motivo obrigatório): SUPERVISOR e ADMIN; nunca o SELLER. Só o ADMIN altera a data da venda; só SUPERVISOR/ADMIN trocam o responsável | `sales:view/create/setDate/reverse/reactivate`; `createSale` |
| C37 | **Venda com Follow-up 3 vencido ou negociação vencida é permitida**: a venda leva o lead a Fechamento e preserva o histórico. As restrições dessas situações para as demais operações de Leads continuam | `createSale` (não aplica `assertSellerMayChange` nem o bloqueio de negociação) |
| C40 | **Preço de venda por item**: cada curso da venda tem preço próprio (> 0), distinto do custo da bolsa; o mesmo curso pode repetir com preços diferentes; o total é a soma dos itens atuais, calculada no servidor e conferida pelo banco. SELLER registra e inclui itens com preço, mas não remove itens nem corrige preços; SUPERVISOR e ADMIN removem e corrigem (preservando custo e comissão da época) | migration 004; `createSale`, `updateSale` |
| C39 | **Estorno e reativação**: com outra venda válida, o estorno mantém o lead em Fechamento e o responsável. Estornada a última venda válida, o lead volta para Lead cadastrado em ciclo `REOPENED`, mantendo o responsável se ele estiver ativo e elegível, ou na fila do supervisor. A reativação exige motivo, responsável ativo de equipe ativa e lead fora da Lixeira; o lead volta a Fechamento com o responsável da venda. Venda estornada é somente leitura para o SELLER | `reverseSale`, `reactivateSale`, `updateSale` |
| C41 | **Cadastro de leads** (atualiza C5): SELLER, SUPERVISOR e ADMIN cadastram. SELLER na própria carteira; SUPERVISOR para vendedor ativo da equipe que lidera; ADMIN para vendedor ativo de qualquer equipe ativa. O responsável continua sendo sempre um SELLER (o supervisor não ganha carteira). O bloqueio por negociação vencida (C34) continua valendo só para o SELLER que cadastra | `leads:create`, `createLead` |
| C42 | **Visibilidade do Ranking**: ADMIN vê o ranking completo (vendedores e equipes); SUPERVISOR vê o ranking dos vendedores da própria equipe e o ranking das equipes; SELLER vê somente a própria posição no ranking geral de vendedores (ex.: "3º de 25"), sem nomes, quantidades ou faturamento dos colegas. *Atualizada pela C50:* "própria equipe" e o ranking de equipes passam a usar a equipe **atual** do vendedor, não `sales.team_id`; a visibilidade por perfil não muda | `getRanking` |
| C43 | **Participantes do Ranking**: entram só vendedores/equipes com ao menos uma venda válida no período (inclusive vendedor hoje inativo ou que mudou de equipe, pelas vendas da época); o "N" de "Xº de N" conta só esses. Vendedor sem venda no período fica fora do ranking. *Atualizada pela C50:* a equipe participa pelas vendas dos vendedores que estão **hoje** nela, não pela equipe da época | `getRanking` |
| C44 | **Empate no Ranking**: mesmo valor no critério = mesma posição, e a seguinte pula (1º, 2º, 2º, 4º); não há critério de desempate (a ordem alfabética entre empatados é só de exibição) | `rankEntries` |
| C45 | **Faturamento** = soma do valor das vendas válidas pela data da venda (não parcelas recebidas). Estornadas ficam fora de faturamento, vendas, conversão e ranking | `getSalesIndicators`, `getRanking` |
| C46 | **Escopo do Dashboard**: ADMIN global, com custo, lucro e comparação mensal; SUPERVISOR as vendas da equipe registrada na venda (regra histórica do Ranking), **sem custo, lucro ou margem** (resolve a dúvida #5); SELLER só os próprios dados. *Atualizada pela C50:* o critério "equipe registrada na venda" foi substituído pela equipe **atual** do vendedor responsável; as restrições de custo, lucro e margem continuam | `getSalesIndicators`, `getMonthlyComparison` |
| C47 | **Indicadores de leads e conversão**: leads cadastrados no período, carteira atual por etapa e alertas, separados. Conversão = leads cadastrados no período com ao menos uma venda válida ÷ leads cadastrados no período fora da Lixeira × 100 (cada lead uma vez; #28); sem leads elegíveis → "Indisponível", nunca 0% | `getLeadIndicators` |
| C49 | **Lixeira no Dashboard** (opção B): leads na Lixeira ficam fora dos indicadores operacionais (carteira atual por etapa, alertas, fila de decisão). Nas visões globais/históricas do ADMIN podem entrar, sempre identificados quando afetam os números (no Dashboard: "Leads cadastrados" de SUPERVISOR/ADMIN, com a quantidade na Lixeira). Na conversão, ficam fora do denominador (#28). Nenhum perfil ganha visibilidade além do escopo atual | `getLeadIndicators` (`trashedInPeriod`) |
| C48 | **Comparação mensal (ADMIN)**: últimos 12 meses com vendas válidas, faturamento, custo e lucro e variação % sobre o mês anterior; sem base comparável → "Indisponível" | `getMonthlyComparison` |
| C38 | **Equipe inativa**: vendedor dela não é reativado, não recebe leads novos (cadastro, transferência, redistribuição, recuperação) nem vendas novas; nada histórico é alterado. Regularização: o ADMIN reativa a equipe ou transfere o vendedor para uma equipe ativa | `setUserActive`, `createLead`, `loadTargetSeller`, `createSale` |
| C50 | **Escopo de acesso e agrupamento gerencial pela equipe atual** (aprovada em 2026-10-17). ADMIN: acesso global, respeitando as restrições de cada módulo. SUPERVISOR: dados dos vendedores **atualmente** vinculados à equipe que lidera, inclusive vendas anteriores à transferência. SELLER: os próprios dados, como já definido. Vale para escopo e agrupamento por equipe de Vendas, Dashboard, Ranking e dos futuros Parcelas, Certificados e Relatórios, respeitando as permissões de cada módulo. **Substitui** o critério de escopo/agrupamento por `sales.team_id` do Ranking (C42) e do Dashboard (C46) e a parte de escopo da C4. **Não substitui** o valor histórico: `sales.team_id` continua gravado e nunca reescrito; vendas antigas e o histórico de transferências não são alterados. Continuam valendo: faturamento e indicadores pela data da venda (C45), estornadas fora das vendas válidas, comissão pela venda válida, custo e lucro só para ADMIN; nenhuma comissão, valor, data ou registro histórico é alterado. **Complemento aprovado (resolve a #29): vendedor sem equipe atual.** No Dashboard e no Ranking do ADMIN, as vendas válidas dele aparecem agrupadas em **"Sem equipe"** nos indicadores e rankings por equipe e continuam nos totais globais (nunca somem por falta de equipe). O SUPERVISOR continua vendo só os vendedores atualmente na equipe que lidera (com as vendas históricas deles); vendedor sem equipe não entra no escopo de nenhum supervisor. O SELLER continua restrito aos próprios dados | `listSales`/`getSale` (escopo e filtro de equipe do ADMIN pela equipe atual), `getRanking`, `getSalesIndicators` |
| C52 | **Parcelas** (aprovada em 2026-10-17): só **cartão** tem parcelas (Pix é à vista). A parcela n vence **n meses após a data da venda**, no mesmo dia (dia inexistente → último dia do mês); valor = total ÷ quantidade, com os **centavos que sobram na 1ª**. Mudança de total, forma de pagamento, quantidade de parcelas ou data da venda: **sem parcela paga, o cronograma é refeito**; **com parcela paga, a mudança é recusada**. **Estorno cancela as parcelas em aberto** (pagas continuam pagas); **reativação as reabre**. Pagamento registrado uma vez, com data/hora do servidor | migration 006; `createSale`, `updateSale`, `reverseSale`, `reactivateSale`, `markInstallmentPaid` |
| C51 | **Certificados** (aprovada em 2026-10-17): só itens atuais (não removidos) de **vendas válidas** recebem certificado; o registro é feito **de uma vez**, com conclusão, entrega e certificadora obrigatórias, datas não futuras e entrega ≥ conclusão; o vendedor exibido é o **responsável atual da venda**, lido na hora (sem cópia no certificado; o da época pode ser reconstruído pelo histórico da venda, se decidido depois) | `registerCertificate`, `listCertificates`, migration 005 |

### Decisões técnicas

- **Política de senha**: mínimo de 8 caracteres; troca pelo próprio usuário exige a senha atual; o admin pode redefinir. Trocar ou redefinir a senha encerra todas as sessões. Não há recuperação por e-mail nesta fase (Documento Mestre §26).
- **Sessão**: 12 h (`SESSION_TTL_HOURS`), sem renovação deslizante.
- **Login**: mensagem genérica, tempo constante para e-mail inexistente, limite de 10 tentativas a cada 15 min por e-mail+IP (em memória; com múltiplas instâncias, mover para o Postgres).
- **Papel do usuário é imutável** depois de criado (trigger). Trocar papel tem efeitos em equipes, leads e vendas que ainda não foram definidos.
- **Desativar supervisor** exige antes definir outro supervisor para a equipe que ele lidera. **Inativar equipe** exige que ela não tenha vendedores ativos nem leads em operação (C22).
- **Primeiro administrador**: `npm run admin:create` (interativo, senha sem eco, nunca por argumento/arquivo/pipe). Usa o mesmo `hashPassword` e as mesmas validações da aplicação; recusa se já existir ADMIN ou se o e-mail já existir. O usuário e o evento `auth.admin_bootstrapped` (`actor_id = NULL`, metadata `{ source: "admin:create" }`) são gravados na mesma transação, sob um advisory lock contra execuções simultâneas.
- **Acesso negado em páginas** responde **404** (não revela existência). Não há `loading.tsx` envolvendo páginas com checagem de acesso, para que o status HTTP seja real.

## 9. Dúvidas em aberto

Resolvidas pelo cliente: C1–C52 (§8). As linhas abaixo mantêm a numeração original; as resolvidas foram removidas. Pendentes:

| # | Dúvida | Contexto | Padrão atual | Fase |
|---|---|---|---|---|
| 3 | Vendedor pode **exportar relatórios** (só os próprios dados)? | §4.4: "Não confirmado" | Negado | Relatórios |
| 4 | ~~Depois da venda~~ — **resolvida:** o lead fica em Fechamento enquanto houver venda válida e pode comprar de novo; estornada a última venda válida, volta para Lead cadastrado em novo ciclo `REOPENED` (Etapa 3b) | — | — | — |
| 5 | ~~Supervisor vê lucro/custo agregado do time?~~ — **resolvida (C46):** não; custo, lucro e margem só para o ADMIN | — | — | — |
| 6 | **"Por curso/aluno"**: uma venda pode ter cursos de **alunos diferentes**? | §14 e RA-03 | Item = curso; aluno = lead da venda | Vendas |
| 7 | ~~Custo de bolsa alterado~~ — **resolvida:** vendas antigas mantêm o custo e a comissão da época (snapshot em `sale_items`) | — | — | — |
| 11 | Formato e colunas de cada relatório — **implementado como decisão técnica** (§26): CSV para Excel pt-BR e as colunas de §3 "Relatórios"; validar com o cliente (ex.: necessidade de `.xlsx` nativo ou de outras colunas) | §26 | CSV `;` com BOM | Relatórios |
| 26 | **SUPERVISOR ou ADMIN movimentam etapas** de um lead da equipe? | C5: só o vendedor tem carteira e follow-ups | Não (`leads:move` = SELLER) | Kanban |
| 27 | **Negociação vencida** deveria bloquear também **parcelas e certificados** quando existirem? | C34 cita só cadastro e movimentação de leads | Não bloqueia | Vendas |
| 29 | ~~Vendedor sem equipe atual no agrupamento por equipe~~ — **resolvida (complemento da C50):** para o ADMIN, no Dashboard e no Ranking, as vendas válidas dele ficam no grupo "Sem equipe" e continuam nos totais globais; fora do escopo de qualquer SUPERVISOR; SELLER sem mudança | — | — | — |
| 28 | ~~Conversão × Lixeira~~ — **resolvida (opção b):** o denominador conta só os leads cadastrados no período que não estão hoje na Lixeira, em todos os perfis; o numerador não muda; sem leads elegíveis → "Indisponível" | — | — | — |
