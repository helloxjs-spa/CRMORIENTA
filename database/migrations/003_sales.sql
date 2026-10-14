-- =============================================================================
-- 003_sales.sql
-- CRM Polo Educacional — fundação do módulo de Vendas
--
-- Pré-requisitos: 001_supabase_initial_schema.sql e 002_leads.sql executados.
-- Executar UMA vez, pelo SQL Editor do Supabase, DEPOIS das queries de
-- diagnóstico (todas devem retornar 0 / vazio).
-- Tudo roda numa única transação: se algo falhar, nada é criado.
--
-- Cria: sales, sale_items, sale_events (+ 3 enums).
-- Altera de forma incremental (sem perda de dados e sem tocar em funções do 002):
--   - lead_cycle_kind  += 'REOPENED'   (novo ciclo comercial após o último estorno)
--   - lead_event_type  += 'SALE_CREATED', 'SALE_REVERSED', 'SALE_REACTIVATED', 'SALE_SELLER_CHANGED'
--   - lead_events      += coluna sale_id (FK composta para a venda do mesmo lead)
--   - leads            += 2 triggers novos (responsável de lead em Fechamento;
--                         coerência lead x vendas)
--   - users            += 1 trigger novo (desativação/troca de equipe de
--                         vendedor só em READ COMMITTED)
--
-- Nota técnica: valores acrescentados a um enum existente (ALTER TYPE ... ADD
-- VALUE) não podem ser USADOS na mesma transação. Por isso nenhuma CHECK,
-- índice ou cláusula WHEN cita os valores novos; eles só aparecem em corpos de
-- função, avaliados em uso real, depois do COMMIT desta migration.
--
-- AUDITORIA (sale_events) — o conteúdo é do BANCO, não de quem grava:
--   - o banco guarda o estado comercial da venda no início de cada transação
--     que a altera (sales.tx_base) e marca os itens incluídos/removidos por
--     transação (added_txid / removed_txid);
--   - ao gravar um evento, o banco CALCULA o metadata (antes/depois só do que
--     mudou; itens incluídos/removidos; retrato inicial; de/para do status) e
--     ignora o que foi enviado;
--   - no COMMIT, o banco confere que o histórico corresponde EXATAMENTE à
--     mudança líquida da transação: mudança sem evento, evento sem mudança e
--     evento que não bate com o estado final são recusados.
--   O serviço só escolhe o tipo, o ator e o motivo, e grava o evento DEPOIS
--   das alterações da operação.
--
-- Divisão de responsabilidades:
--   BANCO   — integridade estrutural, snapshots imutáveis, carimbos de tempo do
--             servidor, auditoria fiel e obrigatória da venda e dos itens,
--             transições de status reais, coerência lead x vendas, e locks que
--             serializam as operações concorrentes do mesmo lead/da mesma venda.
--   SERVIÇO — RBAC e escopo (supervisor: equipe ATUAL do vendedor
--             responsável), quem pode escolher qual vendedor, data só pelo
--             ADMIN, comissão vigente (business-rules.ts), eventos na linha do
--             tempo do lead (lead_events) e o destino do lead. Ordem de travas
--             obrigatória: vendedores envolvidos (users FOR SHARE, por id) →
--             lead (FOR UPDATE) → venda → itens, decidindo só depois de travar.
--   Isolamento: criar, estornar e reativar venda, desativar vendedor e trocar
--   vendedor de equipe SÓ em READ COMMITTED (padrão do PostgreSQL/Supabase e
--   do db.transaction da aplicação); o banco recusa qualquer outro nível. As
--   checagens no COMMIT precisam reler o estado já commitado: em REPEATABLE
--   READ, e em SERIALIZABLE quando a transação concorrente não é SERIALIZABLE,
--   elas veriam um retrato antigo (testes de concorrência P14, P15 e MIX).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Enums novos e valores novos em enums existentes
-- -----------------------------------------------------------------------------

-- Situação da venda. REVERSED = estornada: continua existindo, mas não conta
-- em faturamento, lucro, ranking, comissão ou indicadores.
CREATE TYPE public.sale_status AS ENUM ('ACTIVE', 'REVERSED');

-- Forma de pagamento. PIX é sempre à vista (installment_count NULL);
-- CARD exige a quantidade de parcelas (>= 1, sem máximo definido).
CREATE TYPE public.payment_method AS ENUM ('PIX', 'CARD');

-- Histórico da venda (append-only).
CREATE TYPE public.sale_event_type AS ENUM (
  'CREATED',      -- retrato inicial (campos comerciais e itens)
  'UPDATED',      -- antes/depois só dos campos alterados; itens incluídos/removidos
  'REVERSED',     -- estorno (motivo obrigatório)
  'REACTIVATED'   -- desfazer estorno (motivo obrigatório)
);

-- Novo ciclo comercial aberto quando o ÚLTIMO estorno devolve o lead para
-- "Lead cadastrado". Não é Retrabalho (que nasce de redistribuição/recuperação).
ALTER TYPE public.lead_cycle_kind ADD VALUE 'REOPENED';

-- Fatos de venda na linha do tempo do lead.
ALTER TYPE public.lead_event_type ADD VALUE 'SALE_CREATED';         -- lead foi para Fechamento (e talvez mudou de responsável)
ALTER TYPE public.lead_event_type ADD VALUE 'SALE_REVERSED';        -- venda estornada (pode reabrir o lead em novo ciclo)
ALTER TYPE public.lead_event_type ADD VALUE 'SALE_REACTIVATED';     -- estorno desfeito: lead volta a Fechamento
ALTER TYPE public.lead_event_type ADD VALUE 'SALE_SELLER_CHANGED';  -- responsável de venda válida trocado: lead acompanha

-- -----------------------------------------------------------------------------
-- 2. Tabelas
-- -----------------------------------------------------------------------------

-- Venda.
-- Atribuição de equipe (regras confirmadas):
--   - team_id = equipe ATUAL do vendedor responsável no momento em que ele
--     passou a ser o responsável (criação ou troca explícita do responsável).
--     Faturamento/ranking/indicadores por equipe agrupam por team_id;
--   - supervisor_id = supervisor dessa equipe naquele momento: valor HISTÓRICO,
--     para auditoria. O ranking por supervisor usa o supervisor ATUAL da equipe
--     (teams.supervisor_id via team_id), não esta coluna (regra 2);
--   - o vendedor mudar de equipe na estrutura NÃO altera team_id/supervisor_id
--     das vendas (decisão C4); só a troca explícita do responsável altera;
--   - o escopo do SUPERVISOR sobre a venda usa a equipe ATUAL do vendedor
--     responsável (users.team_id via seller_id), não team_id (regra 3, serviço).
CREATE TABLE public.sales (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  lead_id           uuid NOT NULL,                -- imutável
  seller_id         uuid NOT NULL,                -- sempre SELLER
  team_id           uuid NOT NULL,
  supervisor_id     uuid,
  -- Data comercial (faturamento, ranking, dashboards, relatórios), no fuso do
  -- negócio; informada pela aplicação. Só o ADMIN altera depois (serviço).
  sale_date         date NOT NULL,
  total_cents       integer NOT NULL,
  payment_method    public.payment_method NOT NULL,
  installment_count integer,
  status            public.sale_status DEFAULT 'ACTIVE' NOT NULL,
  -- Quem registrou (SELLER, SUPERVISOR ou ADMIN) e quando. Imutáveis.
  created_by        uuid NOT NULL,
  created_at        timestamp with time zone DEFAULT now() NOT NULL,
  updated_at        timestamp with time zone DEFAULT now() NOT NULL,  -- carimbado pelo banco
  -- Controle técnico da auditoria, mantido SÓ pelo banco (não usar em regra
  -- de negócio): transação que alterou a venda por último e o estado
  -- comercial da venda no início dela (NULL = venda criada nessa transação).
  last_change_txid  bigint DEFAULT txid_current() NOT NULL,
  tx_base           jsonb,
  CONSTRAINT sales_total_positive CHECK (total_cents > 0),
  CONSTRAINT sales_installments_consistent CHECK (
    (payment_method = 'PIX' AND installment_count IS NULL)
    OR (payment_method = 'CARD' AND installment_count IS NOT NULL AND installment_count >= 1)
  ),
  -- Alvo da FK composta de lead_events (evento e venda do MESMO lead).
  CONSTRAINT sales_lead_id_id_unique UNIQUE (lead_id, id)
);

-- Item = UMA ocorrência de curso vendido (o mesmo curso pode repetir na mesma
-- venda; cada ocorrência conta custo e comissão). Nunca é apagado nem
-- alterado: a única mudança possível é a remoção lógica, uma vez.
-- Itens atuais = removed_at IS NULL.
CREATE TABLE public.sale_items (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  sale_id                   uuid NOT NULL,
  course_id                 uuid NOT NULL,
  -- Custo da bolsa vigente na inclusão do item (o banco confere com course_costs).
  cost_snapshot_cents       integer NOT NULL,
  -- Comissão vigente na inclusão do item (o serviço usa business-rules.ts).
  commission_snapshot_cents integer NOT NULL,
  added_at                  timestamp with time zone DEFAULT now() NOT NULL,  -- carimbado pelo banco
  added_by                  uuid NOT NULL,
  removed_at                timestamp with time zone,                         -- carimbado pelo banco
  removed_by                uuid,
  -- Controle técnico da auditoria (só o banco preenche).
  added_txid                bigint DEFAULT txid_current() NOT NULL,
  removed_txid              bigint,
  CONSTRAINT sale_items_cost_non_negative CHECK (cost_snapshot_cents >= 0),
  CONSTRAINT sale_items_commission_non_negative CHECK (commission_snapshot_cents >= 0),
  CONSTRAINT sale_items_removal_consistent CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removed_txid IS NULL)
    OR (removed_at IS NOT NULL AND removed_by IS NOT NULL AND removed_txid IS NOT NULL AND removed_at >= added_at)
  )
);

-- Histórico próprio da venda (append-only). Suporta quantos estornos e
-- reativações acontecerem. metadata é CALCULADO pelo banco:
--   CREATED     {"sale": {campos e status}, "items": [itens atuais]}
--   UPDATED     {"changes": {campo: {"from", "to"}}, "itemsAdded": [...], "itemsRemoved": [...]}
--   REVERSED /
--   REACTIVATED {"status": {"from", "to"}}
-- occurred_at e txid também são do banco.
CREATE TABLE public.sale_events (
  id          bigserial PRIMARY KEY NOT NULL,
  sale_id     uuid NOT NULL,
  type        public.sale_event_type NOT NULL,
  actor_id    uuid NOT NULL,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL,
  txid        bigint DEFAULT txid_current() NOT NULL,
  reason      text,
  metadata    jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT sale_events_reason_required CHECK (
    (type IN ('REVERSED', 'REACTIVATED')) = (reason IS NOT NULL)
    AND (reason IS NULL OR btrim(reason) <> '')
  ),
  CONSTRAINT sale_events_metadata_present CHECK (metadata <> '{}'::jsonb)
);

-- Linha do tempo do lead: referência à venda nos eventos de venda.
-- (Coluna nullable, sem default: não reescreve as linhas existentes.)
ALTER TABLE public.lead_events ADD COLUMN sale_id uuid;

-- -----------------------------------------------------------------------------
-- 3. Foreign keys (RESTRICT: nada comercial/histórico é apagado em cascata)
-- -----------------------------------------------------------------------------
ALTER TABLE public.sales ADD CONSTRAINT sales_lead_id_leads_id_fk
  FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sales ADD CONSTRAINT sales_seller_id_users_id_fk
  FOREIGN KEY (seller_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sales ADD CONSTRAINT sales_team_id_teams_id_fk
  FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sales ADD CONSTRAINT sales_supervisor_id_users_id_fk
  FOREIGN KEY (supervisor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sales ADD CONSTRAINT sales_created_by_users_id_fk
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_sale_id_sales_id_fk
  FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_course_id_courses_id_fk
  FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_added_by_users_id_fk
  FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_removed_by_users_id_fk
  FOREIGN KEY (removed_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.sale_events ADD CONSTRAINT sale_events_sale_id_sales_id_fk
  FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sale_events ADD CONSTRAINT sale_events_actor_id_users_id_fk
  FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_sale_fk
  FOREIGN KEY (lead_id, sale_id) REFERENCES public.sales(lead_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Evento de venda ⇔ sale_id preenchido, e sempre com responsável.
-- Escrita "pelo avesso" (lista dos tipos ANTIGOS) porque os tipos SALE_* foram
-- criados nesta mesma transação e ainda não podem ser citados. Ao adicionar
-- um tipo NÃO relacionado a venda no futuro, esta CHECK deve ser atualizada.
-- (Validada contra as linhas existentes: todas têm tipo antigo e sale_id NULL.)
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_sale_reference CHECK (
  (type IN ('CREATED', 'DETAILS_UPDATED', 'STAGE_CHANGED', 'TRANSFERRED', 'TEAM_CHANGED',
            'UNASSIGNED', 'REDISTRIBUTED', 'TRASHED', 'RESTORED', 'NOTE_ADDED'))
  = (sale_id IS NULL)
);
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_sale_has_owner CHECK (
  sale_id IS NULL OR owner_id IS NOT NULL
);

-- -----------------------------------------------------------------------------
-- 4. Índices
-- -----------------------------------------------------------------------------
-- Vendas de um lead (detalhe do lead; contagem de vendas válidas no COMMIT).
CREATE INDEX sales_lead_idx ON public.sales USING btree (lead_id);
-- Faturamento/ranking/comissão por vendedor e período (status = 'ACTIVE').
CREATE INDEX sales_seller_status_date_idx ON public.sales USING btree (seller_id, status, sale_date);
-- Faturamento/ranking por equipe e período.
CREATE INDEX sales_team_status_date_idx ON public.sales USING btree (team_id, status, sale_date);
-- Faturamento geral por período; área de estornos (status = 'REVERSED').
CREATE INDEX sales_status_date_idx ON public.sales USING btree (status, sale_date);

-- Itens de uma venda (somas atuais, "pelo menos um item", itens da transação).
CREATE INDEX sale_items_sale_idx ON public.sale_items USING btree (sale_id);

-- Histórico de uma venda e verificação da auditoria no COMMIT.
CREATE INDEX sale_events_sale_idx ON public.sale_events USING btree (sale_id, txid);
-- Um único CREATED por venda.
CREATE UNIQUE INDEX sale_events_one_created ON public.sale_events USING btree (sale_id) WHERE type = 'CREATED';
-- No máximo um UPDATED e um evento de status por venda e transação.
CREATE UNIQUE INDEX sale_events_one_update_per_tx ON public.sale_events USING btree (sale_id, txid) WHERE type = 'UPDATED';
CREATE UNIQUE INDEX sale_events_one_status_change_per_tx ON public.sale_events USING btree (sale_id, txid)
  WHERE type IN ('REVERSED', 'REACTIVATED');

-- -----------------------------------------------------------------------------
-- 5. Funções e triggers
-- -----------------------------------------------------------------------------

-- 5.1 Sem exclusão física; histórico append-only (reusa forbid_operation do 002).
CREATE TRIGGER sales_no_delete
  BEFORE DELETE ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER sales_no_truncate
  BEFORE TRUNCATE ON public.sales
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER sale_items_no_delete
  BEFORE DELETE ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER sale_items_no_truncate
  BEFORE TRUNCATE ON public.sale_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER sale_events_append_only
  BEFORE UPDATE OR DELETE ON public.sale_events
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER sale_events_no_truncate
  BEFORE TRUNCATE ON public.sale_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();

-- 5.2 Venda — antes de gravar (INSERT/UPDATE):
--   - id, lead_id, created_at e created_by imutáveis; venda nasce ACTIVE e
--     não muda de status na transação que a criou;
--   - updated_at, last_change_txid e tx_base são do banco (tx_base = estado
--     comercial no início da transação, guardado na 1ª alteração dela);
--   - responsável sempre SELLER ATIVO e com equipe. Na criação E na troca de
--     responsável, team_id = equipe ATUAL do vendedor e supervisor_id =
--     supervisor ATUAL dessa equipe, gravado como histórico (regra 1). Sem
--     troca de responsável, equipe e supervisor da venda não mudam — inclusive
--     quando o vendedor troca de equipe na estrutura (decisão C4);
--   - criação e mudança de status TRAVAM a linha do lead (FOR UPDATE): as
--     mudanças de vendas de um mesmo lead ficam em fila, e a checagem
--     "ainda há venda válida?" no COMMIT enxerga as transações anteriores;
--   - venda nova só para lead ATIVO (fora da Lixeira).
--   Ordem das travas dentro do trigger: vendedor (users FOR SHARE) → equipe
--   (teams FOR SHARE) → lead (FOR UPDATE), a mesma ordem usuário → lead da
--   desativação e da troca de equipe de vendedor (users.service). Num UPDATE,
--   o PostgreSQL já travou a linha da VENDA antes de chamar este trigger
--   (venda → vendedor → equipe → lead): por isso o serviço trava vendedores e
--   lead ANTES de alterar a venda (ver cabeçalho).
CREATE OR REPLACE FUNCTION public.sale_commercial_state(s public.sales) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'sellerId', s.seller_id, 'teamId', s.team_id, 'supervisorId', s.supervisor_id,
    'saleDate', s.sale_date, 'totalCents', s.total_cents,
    'paymentMethod', s.payment_method, 'installmentCount', s.installment_count
  );
$$;

CREATE OR REPLACE FUNCTION public.sale_before_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  seller_role       public.user_role;
  seller_active     boolean;
  seller_team       uuid;
  team_supervisor   uuid;
  lead_status_value public.lead_status;
  seller_changed    boolean;
BEGIN
  -- 0) Isolamento: criar venda ou mudar o status dela depende de enxergar,
  --    depois de travar o lead, o que outras transações já commitaram. Só
  --    READ COMMITTED garante isso: em REPEATABLE READ, e em SERIALIZABLE
  --    junto de transações READ COMMITTED, o retrato é fixo e a coerência
  --    lead x vendas se perde (P14 e MIX dos testes de concorrência).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'vendas: criação, estorno e reativação exigem transação READ COMMITTED';
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'vendas: criação, estorno e reativação exigem transação READ COMMITTED';
    END IF;
  END IF;

  -- 1) Imutáveis e controle técnico (sem travar nada).
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'venda nova nasce válida (ACTIVE)';
    END IF;
    NEW.created_at := now();
    NEW.tx_base := NULL;
    seller_changed := true;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.lead_id IS DISTINCT FROM OLD.lead_id THEN
      RAISE EXCEPTION 'sales.id e sales.lead_id são imutáveis: estorne e registre a venda no lead correto';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'sales.created_at e sales.created_by são imutáveis';
    END IF;
    IF OLD.last_change_txid IS DISTINCT FROM txid_current() THEN
      NEW.tx_base := public.sale_commercial_state(OLD) || jsonb_build_object('status', OLD.status);
    ELSE
      NEW.tx_base := OLD.tx_base;
    END IF;
    -- tx_base NULL = venda criada nesta transação: ela nasce e é auditada
    -- (CREATED) como válida; estorno só em transação posterior, com REVERSED.
    IF NEW.tx_base IS NULL AND NEW.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'venda nova nasce válida (ACTIVE): não pode ser estornada na transação que a criou';
    END IF;
    seller_changed := NEW.seller_id IS DISTINCT FROM OLD.seller_id;
    IF NOT seller_changed
       AND (NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.supervisor_id IS DISTINCT FROM OLD.supervisor_id) THEN
      RAISE EXCEPTION 'equipe e supervisor da venda só mudam junto com a troca do responsável';
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.last_change_txid := txid_current();

  -- 2) Responsável (users → teams), antes de travar o lead.
  IF seller_changed THEN
    SELECT role, active, team_id INTO seller_role, seller_active, seller_team
      FROM public.users WHERE id = NEW.seller_id FOR SHARE;
    IF seller_role IS DISTINCT FROM 'SELLER' THEN
      RAISE EXCEPTION 'sales.seller_id deve referenciar um usuário SELLER';
    END IF;
    IF NOT seller_active THEN
      RAISE EXCEPTION 'sales.seller_id deve referenciar um vendedor ativo';
    END IF;
    IF seller_team IS NULL THEN
      RAISE EXCEPTION 'o vendedor responsável precisa estar em uma equipe';
    END IF;
    SELECT supervisor_id INTO team_supervisor FROM public.teams WHERE id = seller_team FOR SHARE;
    IF NEW.team_id IS DISTINCT FROM seller_team OR NEW.supervisor_id IS DISTINCT FROM team_supervisor THEN
      RAISE EXCEPTION 'sales.team_id/supervisor_id devem ser a equipe atual do vendedor responsável e o supervisor atual dela';
    END IF;
  END IF;

  -- 3) Lead (por último).
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO lead_status_value FROM public.leads WHERE id = NEW.lead_id FOR UPDATE;
    IF lead_status_value IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'venda só pode ser registrada para lead ativo (fora da Lixeira)';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM 1 FROM public.leads WHERE id = NEW.lead_id FOR UPDATE;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_before_write
  BEFORE INSERT OR UPDATE ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.sale_before_write();

-- 5.3 Item — antes de gravar:
--   INSERT: curso ATIVO, com custo cadastrado, snapshot igual ao custo vigente
--           (lidos com FOR SHARE: mudança de custo concorrente espera e o
--           snapshot é conferido contra o valor efetivamente vigente); nasce
--           não removido; added_at e added_txid são do banco.
--   UPDATE: a ÚNICA mudança permitida é a remoção lógica, uma vez: removed_at
--           (carimbado pelo banco) e removed_by passam de NULL a preenchidos;
--           todo o resto (inclusive id e snapshots) é imutável. Um item não
--           pode ser removido na mesma transação em que foi incluído (não
--           sobraria registro dele em nenhum evento).
--   Em ambos: a venda é "tocada" (UPDATE ... updated_at), o que trava a linha
--   da venda — inclusões/remoções concorrentes na mesma venda ficam em fila e
--   a checagem "pelo menos um item" no COMMIT enxerga as anteriores — e marca
--   a venda como alterada nesta transação (passa a exigir auditoria).
CREATE OR REPLACE FUNCTION public.sale_item_before_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  course_active boolean;
  current_cost  integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL OR NEW.removed_by IS NOT NULL OR NEW.removed_txid IS NOT NULL THEN
      RAISE EXCEPTION 'item novo não pode nascer removido';
    END IF;
    SELECT active INTO course_active FROM public.courses WHERE id = NEW.course_id FOR SHARE;
    IF course_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'só cursos ativos podem ser vendidos';
    END IF;
    SELECT cost_cents INTO current_cost FROM public.course_costs WHERE course_id = NEW.course_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'curso sem custo de bolsa cadastrado não pode ser vendido';
    END IF;
    IF NEW.cost_snapshot_cents IS DISTINCT FROM current_cost THEN
      RAISE EXCEPTION 'sale_items.cost_snapshot_cents deve ser o custo vigente do curso';
    END IF;
    NEW.added_at := now();
    NEW.added_txid := txid_current();
  ELSE
    IF OLD.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'sale_items: item removido é imutável';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
       OR NEW.course_id IS DISTINCT FROM OLD.course_id
       OR NEW.cost_snapshot_cents IS DISTINCT FROM OLD.cost_snapshot_cents
       OR NEW.commission_snapshot_cents IS DISTINCT FROM OLD.commission_snapshot_cents
       OR NEW.added_at IS DISTINCT FROM OLD.added_at
       OR NEW.added_by IS DISTINCT FROM OLD.added_by
       OR NEW.added_txid IS DISTINCT FROM OLD.added_txid THEN
      RAISE EXCEPTION 'sale_items: só a remoção do item pode ser registrada';
    END IF;
    IF NEW.removed_at IS NULL OR NEW.removed_by IS NULL THEN
      RAISE EXCEPTION 'sale_items: a única alteração permitida é remover o item (removed_at e removed_by)';
    END IF;
    IF OLD.added_txid = txid_current() THEN
      RAISE EXCEPTION 'sale_items: item incluído nesta transação não pode ser removido nela';
    END IF;
    NEW.removed_at := now();
    NEW.removed_txid := txid_current();
  END IF;

  UPDATE public.sales SET updated_at = now() WHERE id = NEW.sale_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sale_items_before_write
  BEFORE INSERT OR UPDATE ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public.sale_item_before_write();

-- 5.4 Conteúdo esperado de cada evento, calculado a partir do estado atual da
-- venda e do que mudou NESTA transação. NULL = não há o que registrar.
CREATE OR REPLACE FUNCTION public.sale_item_snapshot(i public.sale_items) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', i.id, 'courseId', i.course_id,
    'costSnapshotCents', i.cost_snapshot_cents, 'commissionSnapshotCents', i.commission_snapshot_cents
  );
$$;

CREATE OR REPLACE FUNCTION public.sale_expected_event(target_sale uuid, event_type public.sale_event_type) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  s             public.sales;
  current_state jsonb;
  changes       jsonb;
  items_added   jsonb;
  items_removed jsonb;
BEGIN
  SELECT * INTO s FROM public.sales WHERE id = target_sale;
  IF NOT FOUND OR s.last_change_txid IS DISTINCT FROM txid_current() THEN
    RETURN NULL;  -- a venda não foi alterada nesta transação
  END IF;

  IF event_type = 'CREATED' THEN
    IF s.tx_base IS NOT NULL THEN
      RETURN NULL;  -- só existe na transação que criou a venda
    END IF;
    RETURN jsonb_build_object(
      'sale', public.sale_commercial_state(s) || jsonb_build_object('status', s.status),
      'items', coalesce((SELECT jsonb_agg(public.sale_item_snapshot(i) ORDER BY i.id)
                           FROM public.sale_items i WHERE i.sale_id = target_sale AND i.removed_at IS NULL), '[]'::jsonb)
    );
  END IF;

  IF s.tx_base IS NULL THEN
    RETURN NULL;  -- na transação de criação só existe o CREATED
  END IF;

  IF event_type = 'UPDATED' THEN
    current_state := public.sale_commercial_state(s);
    SELECT coalesce(jsonb_object_agg(k.key, jsonb_build_object('from', s.tx_base -> k.key, 'to', current_state -> k.key)), '{}'::jsonb)
      INTO changes
      FROM jsonb_object_keys(current_state) AS k(key)
     WHERE (s.tx_base -> k.key) IS DISTINCT FROM (current_state -> k.key);
    SELECT coalesce(jsonb_agg(public.sale_item_snapshot(i) ORDER BY i.id), '[]'::jsonb) INTO items_added
      FROM public.sale_items i WHERE i.sale_id = target_sale AND i.added_txid = txid_current();
    SELECT coalesce(jsonb_agg(public.sale_item_snapshot(i) ORDER BY i.id), '[]'::jsonb) INTO items_removed
      FROM public.sale_items i WHERE i.sale_id = target_sale AND i.removed_txid = txid_current();
    IF changes = '{}'::jsonb AND items_added = '[]'::jsonb AND items_removed = '[]'::jsonb THEN
      RETURN NULL;  -- nenhuma mudança comercial líquida
    END IF;
    RETURN jsonb_build_object('changes', changes, 'itemsAdded', items_added, 'itemsRemoved', items_removed);
  END IF;

  -- REVERSED / REACTIVATED: transição líquida de status na direção do evento.
  IF (event_type = 'REVERSED' AND s.tx_base ->> 'status' = 'ACTIVE' AND s.status = 'REVERSED')
     OR (event_type = 'REACTIVATED' AND s.tx_base ->> 'status' = 'REVERSED' AND s.status = 'ACTIVE') THEN
    RETURN jsonb_build_object('status', jsonb_build_object('from', s.tx_base ->> 'status', 'to', s.status));
  END IF;
  RETURN NULL;
END;
$$;

-- 5.5 Evento — antes de gravar: occurred_at, txid e metadata são do banco.
-- O evento deve ser gravado DEPOIS das alterações que ele descreve.
CREATE OR REPLACE FUNCTION public.sale_event_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  expected jsonb;
BEGIN
  NEW.occurred_at := now();
  NEW.txid := txid_current();
  expected := public.sale_expected_event(NEW.sale_id, NEW.type);
  IF expected IS NULL THEN
    RAISE EXCEPTION 'evento % da venda % não corresponde a nenhuma alteração real feita nesta transação (grave o evento depois das alterações)',
      NEW.type, NEW.sale_id;
  END IF;
  NEW.metadata := expected;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sale_events_before_insert
  BEFORE INSERT ON public.sale_events
  FOR EACH ROW EXECUTE FUNCTION public.sale_event_before_insert();

-- 5.6 Verificações no COMMIT (constraint triggers DEFERRABLE INITIALLY
-- DEFERRED). Rodam no fim da transação, sobre o estado final dela e o das
-- transações que commitaram antes (os locks de 5.2/5.3 garantem que as
-- anteriores do mesmo lead/venda já commitaram).

-- Coerência lead x vendas: lead tem venda válida ⇔ lead em Fechamento e ATIVO.
CREATE OR REPLACE FUNCTION public.assert_lead_sale_state(target_lead uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  lead_stage_value  public.lead_stage;
  lead_status_value public.lead_status;
  active_sales      integer;
BEGIN
  SELECT stage, status INTO lead_stage_value, lead_status_value FROM public.leads WHERE id = target_lead;
  SELECT count(*) INTO active_sales FROM public.sales WHERE lead_id = target_lead AND status = 'ACTIVE';
  IF active_sales > 0 AND (lead_stage_value <> 'CLOSED' OR lead_status_value <> 'ACTIVE') THEN
    RAISE EXCEPTION 'lead % tem venda válida e deve estar em Fechamento', target_lead;
  END IF;
  IF active_sales = 0 AND lead_stage_value = 'CLOSED' THEN
    RAISE EXCEPTION 'lead % em Fechamento precisa de pelo menos uma venda válida', target_lead;
  END IF;
END;
$$;

-- Auditoria e itens da venda, comparando o histórico da transação com a
-- mudança LÍQUIDA (estado final x estado no início da transação):
--   - cada tipo de evento que a mudança exige está presente;
--   - cada evento presente corresponde exatamente ao estado final (eventos de
--     alterações depois desfeitas, ou gravados antes de outras alterações,
--     são recusados);
--   - a venda tem pelo menos um item atual.
CREATE OR REPLACE FUNCTION public.assert_sale_audited(target_sale uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  t         public.sale_event_type;
  expected  jsonb;
  recorded  jsonb;
  n_events  integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sale_items WHERE sale_id = target_sale AND removed_at IS NULL) THEN
    RAISE EXCEPTION 'a venda % precisa de pelo menos um curso', target_sale;
  END IF;

  FOREACH t IN ARRAY ARRAY['CREATED', 'UPDATED', 'REVERSED', 'REACTIVATED']::public.sale_event_type[] LOOP
    expected := public.sale_expected_event(target_sale, t);
    SELECT count(*), max(metadata::text)::jsonb INTO n_events, recorded
      FROM public.sale_events WHERE sale_id = target_sale AND txid = txid_current() AND type = t;
    IF expected IS NOT NULL AND n_events = 0 THEN
      RAISE EXCEPTION 'venda % alterada sem o evento % na mesma transação', target_sale, t;
    END IF;
    IF n_events > 0 AND (expected IS NULL OR recorded IS DISTINCT FROM expected) THEN
      RAISE EXCEPTION 'evento % da venda % não corresponde ao estado final da transação', t, target_sale;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.sale_commit_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN
    PERFORM public.assert_sale_audited(NEW.id);
    PERFORM public.assert_lead_sale_state(NEW.lead_id);
  ELSE
    PERFORM public.assert_sale_audited(NEW.sale_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER sales_commit_check
  AFTER INSERT OR UPDATE ON public.sales
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.sale_commit_check();

CREATE CONSTRAINT TRIGGER sale_items_commit_check
  AFTER INSERT OR UPDATE ON public.sale_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.sale_commit_check();

CREATE CONSTRAINT TRIGGER sale_events_commit_check
  AFTER INSERT ON public.sale_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.sale_commit_check();

-- 5.7 Leads (as funções do 002 NÃO são alteradas):
--   a) lead em Fechamento que troca de responsável/equipe (nova venda, troca
--      do responsável da venda, reativação): responsável SELLER e team_id a
--      equipe atual dele. Não exige vendedor ativo (desativar um vendedor não
--      mexe nos leads fechados dele);
--   b) no COMMIT, coerência lead x vendas também quando o lead muda de etapa
--      ou situação (ex.: tirar de Fechamento ou mandar para a Lixeira).
CREATE OR REPLACE FUNCTION public.check_closed_lead_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  owner_role public.user_role;
  owner_team uuid;
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    SELECT role, team_id INTO owner_role, owner_team FROM public.users WHERE id = NEW.owner_id FOR SHARE;
    IF owner_role IS DISTINCT FROM 'SELLER' THEN
      RAISE EXCEPTION 'leads.owner_id deve referenciar um usuário SELLER';
    END IF;
    IF owner_team IS DISTINCT FROM NEW.team_id THEN
      RAISE EXCEPTION 'leads.team_id deve ser a equipe atual do vendedor responsável';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER leads_closed_owner_guard
  BEFORE UPDATE OF owner_id, team_id ON public.leads
  FOR EACH ROW WHEN (NEW.stage = 'CLOSED')
  EXECUTE FUNCTION public.check_closed_lead_owner();

CREATE OR REPLACE FUNCTION public.lead_sale_state_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.assert_lead_sale_state(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER leads_sale_state
  AFTER INSERT OR UPDATE OF stage, status ON public.leads
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.lead_sale_state_check();

-- 5.8 Vendedores (as funções do 001/002 NÃO são alteradas): desativar um
-- vendedor ou trocá-lo de equipe exige READ COMMITTED.
-- A transação que faz isso leva junto os leads em operação dele (fila ou nova
-- equipe) e o 002 confere no COMMIT que nenhum ficou para trás; em REPEATABLE
-- READ, e em SERIALIZABLE junto de transações READ COMMITTED, as duas coisas
-- leem um retrato antigo e um lead atribuído ao vendedor por outra transação,
-- depois desse retrato, ficaria com responsável inativo ou de outra equipe
-- (P15f/P15g dos testes de concorrência). Só a transição ativo → inativo e a
-- mudança efetiva de equipe de um SELLER são verificadas; ativação, nome,
-- e-mail, senha, criação e usuários ADMIN/SUPERVISOR não.
CREATE OR REPLACE FUNCTION public.check_seller_change_isolation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'vendedores: desativação e troca de equipe exigem transação READ COMMITTED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_seller_change_isolation
  BEFORE UPDATE OF active, team_id ON public.users
  FOR EACH ROW
  WHEN (OLD.role = 'SELLER'
        AND ((OLD.active AND NOT NEW.active) OR NEW.team_id IS DISTINCT FROM OLD.team_id))
  EXECUTE FUNCTION public.check_seller_change_isolation();

-- -----------------------------------------------------------------------------
-- 6. Bloqueio da Data API do Supabase (PostgREST), como no 001/002:
-- RLS ligado SEM políticas + REVOKE para anon/authenticated.
-- -----------------------------------------------------------------------------
ALTER TABLE public.sales       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sales, public.sale_items, public.sale_events FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.sale_events_id_seq FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION
  public.sale_commercial_state(public.sales), public.sale_item_snapshot(public.sale_items),
  public.sale_before_write(), public.sale_item_before_write(),
  public.sale_expected_event(uuid, public.sale_event_type), public.sale_event_before_insert(),
  public.assert_lead_sale_state(uuid), public.assert_sale_audited(uuid), public.sale_commit_check(),
  public.check_closed_lead_owner(), public.lead_sale_state_check(),
  public.check_seller_change_isolation()
  FROM anon, authenticated, PUBLIC;

COMMIT;
