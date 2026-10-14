-- =============================================================================
-- 004_sale_item_prices.sql
-- CRM Polo Educacional — preço de venda por item e total derivado dos itens
--
-- Pré-requisitos: 001, 002 e 003 executados. Executar UMA vez, pelo SQL Editor
-- do Supabase. Tudo roda numa única transação: se algo falhar, nada muda.
--
-- Só pode ser aplicada com as tabelas de vendas VAZIAS (diagnóstico do
-- proprietário: 0 vendas, 0 itens). A migration trava `sales` e `sale_items`
-- (ACCESS EXCLUSIVE) ANTES de conferir: nenhuma venda pode surgir entre a
-- conferência e as alterações. Havendo qualquer venda ou item, ela aborta.
--
-- Regras (confirmadas pelo proprietário):
--   - cada item tem preço de venda próprio (> 0), distinto do custo da bolsa;
--   - sales.total_cents = SUM(price_cents dos itens não removidos), conferido
--     pelo banco no COMMIT de toda transação que mexa na venda ou nos itens
--     (inclusive SQL direto);
--   - o preço de um item existente pode ser corrigido sem recriar o item:
--     custo e comissão (snapshots) continuam exatamente iguais, e o histórico
--     registra o de → para (UPDATED.itemsRepriced);
--   - quem pode corrigir/remover é decidido pelo backend (RBAC); o banco
--     garante a integridade estrutural, para qualquer papel.
--
-- Altera (sem tocar nos arquivos 001–003):
--   - sale_items  += price_cents (NOT NULL, CHECK > 0, sem default)
--                 += price_changed_txid, price_tx_base (controle técnico da
--                    auditoria de correção de preço, mantido SÓ pelo banco)
--   - CREATE OR REPLACE: sale_item_before_write, sale_item_snapshot,
--                        sale_expected_event, sale_commit_check
--   - nova função assert_sale_total (chamada por sale_commit_check, nos mesmos
--     constraint triggers DEFERRABLE do 003: sales, sale_items, sale_events)
-- Funções continuam SECURITY INVOKER, com search_path fixo; CREATE OR REPLACE
-- preserva dono e privilégios (o REVOKE do 003 continua valendo).
-- =============================================================================

BEGIN;

-- Não esperar indefinidamente por travas em produção: falha e nada muda.
SET LOCAL lock_timeout = '10s';

-- -----------------------------------------------------------------------------
-- 0. Guard: aplicação única e tabelas vazias (sob trava exclusiva)
-- -----------------------------------------------------------------------------
LOCK TABLE public.sales, public.sale_items IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sale_items' AND column_name = 'price_cents'
  ) THEN
    RAISE EXCEPTION '004: sale_items.price_cents já existe — esta migration já foi aplicada';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales) OR EXISTS (SELECT 1 FROM public.sale_items) THEN
    RAISE EXCEPTION '004: existem vendas ou itens de venda. Esta migration só pode ser aplicada com as tabelas vazias; nada foi alterado';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. Colunas e constraints
-- -----------------------------------------------------------------------------

-- Preço de venda do item (quanto o aluno paga por esta ocorrência do curso).
ALTER TABLE public.sale_items ADD COLUMN price_cents integer NOT NULL;
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_price_positive CHECK (price_cents > 0);

-- Controle técnico da auditoria de correção de preço (mesmo padrão de
-- sales.tx_base): transação que corrigiu o preço por último e o preço do item
-- no início dela. Só o banco preenche; não usar em regra de negócio.
ALTER TABLE public.sale_items ADD COLUMN price_changed_txid bigint;
ALTER TABLE public.sale_items ADD COLUMN price_tx_base integer;
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_price_change_consistent CHECK (
  (price_changed_txid IS NULL) = (price_tx_base IS NULL)
);

-- -----------------------------------------------------------------------------
-- 2. Item — antes de gravar (substitui a versão do 003)
-- -----------------------------------------------------------------------------
--   INSERT: igual ao 003 (curso ativo, custo vigente conferido, carimbos do
--           banco) + o controle de correção de preço nasce vazio.
--   UPDATE: exatamente UMA destas mudanças, em item não removido:
--     a) remoção lógica (igual ao 003): removed_at/removed_by; preço intacto;
--        item incluído ou com preço corrigido nesta transação não é removido
--        nela (o histórico não teria como registrá-lo);
--     b) correção de preço: só price_cents muda; custo, comissão e todo o resto
--        imutáveis. Em item incluído em transação ANTERIOR, o banco guarda o
--        preço do início desta transação (price_tx_base) para o UPDATED.
--   Em ambos: a venda é "tocada" (trava a linha da venda e exige auditoria),
--   como no 003.
CREATE OR REPLACE FUNCTION public.sale_item_before_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  course_active boolean;
  current_cost  integer;
  removing      boolean;
  repricing     boolean;
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
    NEW.price_changed_txid := NULL;
    NEW.price_tx_base := NULL;
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
      RAISE EXCEPTION 'sale_items: só a remoção do item ou a correção do preço podem ser registradas';
    END IF;

    removing := NEW.removed_at IS NOT NULL OR NEW.removed_by IS NOT NULL;
    repricing := NEW.price_cents IS DISTINCT FROM OLD.price_cents;

    IF removing AND repricing THEN
      RAISE EXCEPTION 'sale_items: remova o item ou corrija o preço, não os dois na mesma alteração';
    ELSIF removing THEN
      IF NEW.removed_at IS NULL OR NEW.removed_by IS NULL THEN
        RAISE EXCEPTION 'sale_items: a remoção exige removed_at e removed_by';
      END IF;
      IF OLD.added_txid = txid_current() THEN
        RAISE EXCEPTION 'sale_items: item incluído nesta transação não pode ser removido nela';
      END IF;
      IF OLD.price_changed_txid = txid_current() THEN
        RAISE EXCEPTION 'sale_items: item com preço corrigido nesta transação não pode ser removido nela';
      END IF;
      NEW.removed_at := now();
      NEW.removed_txid := txid_current();
      NEW.price_changed_txid := OLD.price_changed_txid;
      NEW.price_tx_base := OLD.price_tx_base;
    ELSIF repricing THEN
      IF NEW.removed_txid IS NOT NULL THEN
        RAISE EXCEPTION 'sale_items: só a remoção do item ou a correção do preço podem ser registradas';
      END IF;
      IF OLD.added_txid = txid_current() THEN
        -- Item desta transação: o retrato de inclusão já sai com o preço final.
        NEW.price_changed_txid := OLD.price_changed_txid;
        NEW.price_tx_base := OLD.price_tx_base;
      ELSIF OLD.price_changed_txid IS DISTINCT FROM txid_current() THEN
        NEW.price_tx_base := OLD.price_cents;
        NEW.price_changed_txid := txid_current();
      ELSE
        NEW.price_tx_base := OLD.price_tx_base;
        NEW.price_changed_txid := OLD.price_changed_txid;
      END IF;
    ELSE
      RAISE EXCEPTION 'sale_items: as únicas alterações permitidas são remover o item ou corrigir o preço';
    END IF;
  END IF;

  UPDATE public.sales SET updated_at = now() WHERE id = NEW.sale_id;
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Retrato do item: + preço (CREATED, itemsAdded, itemsRemoved)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sale_item_snapshot(i public.sale_items) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', i.id, 'courseId', i.course_id, 'priceCents', i.price_cents,
    'costSnapshotCents', i.cost_snapshot_cents, 'commissionSnapshotCents', i.commission_snapshot_cents
  );
$$;

-- -----------------------------------------------------------------------------
-- 4. Conteúdo esperado dos eventos: + itemsRepriced no UPDATED
-- -----------------------------------------------------------------------------
--   UPDATED {"changes": {...}, "itemsAdded": [...], "itemsRemoved": [...],
--            "itemsRepriced": [{"id", "courseId", "from", "to"}]}
--   Correção desfeita na mesma transação (preço final = inicial) não conta.
CREATE OR REPLACE FUNCTION public.sale_expected_event(target_sale uuid, event_type public.sale_event_type) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  s              public.sales;
  current_state  jsonb;
  changes        jsonb;
  items_added    jsonb;
  items_removed  jsonb;
  items_repriced jsonb;
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
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'courseId', i.course_id, 'from', i.price_tx_base, 'to', i.price_cents)
                              ORDER BY i.id), '[]'::jsonb) INTO items_repriced
      FROM public.sale_items i
     WHERE i.sale_id = target_sale AND i.price_changed_txid = txid_current()
       AND i.price_tx_base IS DISTINCT FROM i.price_cents;
    IF changes = '{}'::jsonb AND items_added = '[]'::jsonb AND items_removed = '[]'::jsonb AND items_repriced = '[]'::jsonb THEN
      RETURN NULL;  -- nenhuma mudança comercial líquida
    END IF;
    RETURN jsonb_build_object('changes', changes, 'itemsAdded', items_added, 'itemsRemoved', items_removed,
                              'itemsRepriced', items_repriced);
  END IF;

  -- REVERSED / REACTIVATED: transição líquida de status na direção do evento.
  IF (event_type = 'REVERSED' AND s.tx_base ->> 'status' = 'ACTIVE' AND s.status = 'REVERSED')
     OR (event_type = 'REACTIVATED' AND s.tx_base ->> 'status' = 'REVERSED' AND s.status = 'ACTIVE') THEN
    RETURN jsonb_build_object('status', jsonb_build_object('from', s.tx_base ->> 'status', 'to', s.status));
  END IF;
  RETURN NULL;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Total = soma dos itens atuais, conferido no COMMIT
-- -----------------------------------------------------------------------------
-- Chamada pelos mesmos constraint triggers DEFERRABLE INITIALLY DEFERRED do
-- 003 (sales, sale_items, sale_events), ou seja, ao fim de toda transação que
-- criar/alterar a venda ou os itens. As travas do 003 (itens "tocam" a venda)
-- garantem que alterações concorrentes da mesma venda já terminaram.
CREATE OR REPLACE FUNCTION public.assert_sale_total(target_sale uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  sale_total integer;
  items_sum  bigint;
BEGIN
  SELECT total_cents INTO sale_total FROM public.sales WHERE id = target_sale;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(price_cents), 0) INTO items_sum
    FROM public.sale_items WHERE sale_id = target_sale AND removed_at IS NULL;
  IF sale_total IS DISTINCT FROM items_sum THEN
    RAISE EXCEPTION 'venda %: total (%) diferente da soma dos preços dos itens atuais (%)', target_sale, sale_total, items_sum;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sale_commit_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN
    PERFORM public.assert_sale_audited(NEW.id);
    PERFORM public.assert_sale_total(NEW.id);
    PERFORM public.assert_lead_sale_state(NEW.lead_id);
  ELSE
    PERFORM public.assert_sale_audited(NEW.sale_id);
    PERFORM public.assert_sale_total(NEW.sale_id);
  END IF;
  RETURN NULL;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Data API do Supabase: a função nova também fica sem acesso público
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.assert_sale_total(uuid) FROM anon, authenticated, PUBLIC;

COMMIT;
