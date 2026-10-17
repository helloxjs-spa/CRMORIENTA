-- =============================================================================
-- 006_installments.sql
-- CRM Polo Educacional — parcelas do cartão (Documento Mestre §12; decisão C52)
--
-- Pré-requisitos: 001 a 004 executados (não depende do 005). Executar UMA vez,
-- pelo SQL Editor do Supabase. Tudo roda numa única transação: se algo falhar,
-- nada muda. Não altera tabelas, funções ou dados existentes; acrescenta uma
-- tabela, um enum, funções e triggers novos (inclusive um trigger em sales que
-- só confere, no COMMIT, o cronograma de parcelas da venda).
--
-- IMPORTANTE (ordem de implantação): depois desta migration, toda venda com
-- CARTÃO precisa ter o cronograma de parcelas na mesma transação. A versão da
-- aplicação anterior ao módulo de Parcelas não grava parcelas e passará a ter
-- vendas com cartão recusadas: implante o código novo junto.
--
-- Regras (C52, confirmadas pelo proprietário em 2026-10-17):
--   - só CARTÃO gera parcelas; Pix é à vista e não tem parcelas;
--   - parcela n vence em sale_date + n meses (mesmo dia; se o mês não tem o
--     dia, o último dia do mês — é a aritmética de datas do PostgreSQL);
--   - valor = total ÷ quantidade, em centavos; o que sobra fica na 1ª parcela;
--   - total, pagamento, quantidade de parcelas ou data da venda mudam: sem
--     parcela paga, o cronograma é refeito (o anterior fica cancelado, com
--     replaced_at, como histórico); com parcela paga, a mudança é recusada;
--   - estorno cancela as parcelas em aberto (pagas continuam pagas);
--     reativação reabre as canceladas do cronograma atual;
--   - pagamento é registrado uma vez (sem baixa parcial nem desfazer).
--
-- Divisão de responsabilidades:
--   BANCO   — cronograma atual exatamente igual à regra acima (quantidade,
--             números, valores, vencimentos), coerente com a situação da venda
--             (conferido no COMMIT); transições de situação permitidas;
--             parcela paga e parcela substituída imutáveis; sem exclusão física.
--   SERVIÇO — RBAC (installments:markPaid), escopo (C50), gerar/refazer/
--             cancelar/reabrir o cronograma junto das operações de venda e
--             auditoria (audit_events) do pagamento.
-- =============================================================================

BEGIN;

-- Não esperar indefinidamente por travas em produção: falha e nada muda.
SET LOCAL lock_timeout = '10s';

-- Vendas não podem ser gravadas enquanto o cronograma das existentes é criado.
LOCK TABLE public.sales IN SHARE MODE;

-- -----------------------------------------------------------------------------
-- 1. Enum e tabela
-- -----------------------------------------------------------------------------
-- OPEN = em aberto; PAID = paga; CANCELED = cancelada (estorno, ou cronograma
-- substituído — nesse caso replaced_at preenchido).
CREATE TYPE public.installment_status AS ENUM ('OPEN', 'PAID', 'CANCELED');

CREATE TABLE public.installments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  sale_id       uuid NOT NULL,                                     -- imutável
  number        integer NOT NULL,                                  -- 1..N, imutável
  amount_cents  integer NOT NULL,                                  -- imutável
  due_date      date NOT NULL,                                     -- imutável
  status        public.installment_status DEFAULT 'OPEN' NOT NULL,
  paid_at       timestamp with time zone,                          -- carimbado pelo banco
  paid_by       uuid,
  -- Cronograma substituído (venda alterada sem parcela paga): histórico.
  replaced_at   timestamp with time zone,                          -- carimbado pelo banco
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT installments_number_positive CHECK (number >= 1),
  CONSTRAINT installments_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT installments_paid_consistent CHECK (
    (status = 'PAID') = (paid_at IS NOT NULL) AND (paid_at IS NULL) = (paid_by IS NULL)
  ),
  CONSTRAINT installments_replaced_canceled CHECK (replaced_at IS NULL OR status = 'CANCELED')
);

ALTER TABLE public.installments ADD CONSTRAINT installments_sale_id_sales_id_fk
  FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.installments ADD CONSTRAINT installments_paid_by_users_id_fk
  FOREIGN KEY (paid_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Um número por venda no cronograma atual.
CREATE UNIQUE INDEX installments_current_number_unique ON public.installments USING btree (sale_id, number)
  WHERE replaced_at IS NULL;
-- Parcelas de uma venda; lista por vencimento e situação.
CREATE INDEX installments_sale_idx ON public.installments USING btree (sale_id);
CREATE INDEX installments_due_date_idx ON public.installments USING btree (due_date);

-- -----------------------------------------------------------------------------
-- 2. Triggers de linha
-- -----------------------------------------------------------------------------
CREATE TRIGGER installments_no_delete
  BEFORE DELETE ON public.installments
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER installments_no_truncate
  BEFORE TRUNCATE ON public.installments
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();

-- INSERT: nasce em aberto ou cancelada (venda estornada), sem pagamento nem
-- substituição; created_at é do banco.
-- UPDATE: venda, número, valor, vencimento e criação são imutáveis; parcela
-- paga ou substituída não muda mais; transições: OPEN → PAID (paid_at do
-- banco, paid_by obrigatório), OPEN ↔ CANCELED, e OPEN/CANCELED → substituída
-- (CANCELED + replaced_at do banco).
CREATE OR REPLACE FUNCTION public.installment_before_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'PAID' OR NEW.paid_at IS NOT NULL OR NEW.paid_by IS NOT NULL OR NEW.replaced_at IS NOT NULL THEN
      RAISE EXCEPTION 'installments: parcela nasce em aberto ou cancelada, sem pagamento nem substituição';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.sale_id IS DISTINCT FROM OLD.sale_id OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.due_date IS DISTINCT FROM OLD.due_date
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'installments: venda, número, valor, vencimento e criação são imutáveis';
  END IF;
  IF OLD.replaced_at IS NOT NULL THEN
    RAISE EXCEPTION 'installments: parcela de cronograma substituído é imutável';
  END IF;
  IF OLD.status = 'PAID' THEN
    RAISE EXCEPTION 'installments: parcela paga é imutável';
  END IF;

  IF NEW.replaced_at IS NOT NULL THEN
    IF NEW.status <> 'CANCELED' OR NEW.paid_by IS NOT NULL THEN
      RAISE EXCEPTION 'installments: parcela substituída fica cancelada';
    END IF;
    NEW.replaced_at := now();
  ELSIF NEW.status = 'PAID' THEN
    IF OLD.status <> 'OPEN' OR NEW.paid_by IS NULL THEN
      RAISE EXCEPTION 'installments: só parcela em aberto pode ser paga, com quem registrou o pagamento';
    END IF;
    NEW.paid_at := now();
  ELSIF NEW.paid_at IS NOT NULL OR NEW.paid_by IS NOT NULL THEN
    RAISE EXCEPTION 'installments: pagamento só junto da transição para paga';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER installments_before_write
  BEFORE INSERT OR UPDATE ON public.installments
  FOR EACH ROW EXECUTE FUNCTION public.installment_before_write();

-- -----------------------------------------------------------------------------
-- 3. Conferência no COMMIT: o cronograma atual da venda segue a regra C52
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_installment_schedule(target_sale uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  s       public.sales;
  n       integer;
  total   bigint;
  share   integer;
BEGIN
  SELECT * INTO s FROM public.sales WHERE id = target_sale;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT count(*), coalesce(sum(amount_cents), 0) INTO n, total
    FROM public.installments WHERE sale_id = target_sale AND replaced_at IS NULL;

  IF s.payment_method <> 'CARD' THEN
    IF n <> 0 THEN
      RAISE EXCEPTION 'venda % sem cartão não tem parcelas', target_sale;
    END IF;
    RETURN;
  END IF;

  IF n <> s.installment_count OR total <> s.total_cents THEN
    RAISE EXCEPTION 'venda %: o cronograma de parcelas deve ter % parcelas somando o total da venda', target_sale, s.installment_count;
  END IF;
  share := s.total_cents / s.installment_count;
  IF EXISTS (
    SELECT 1 FROM public.installments i
     WHERE i.sale_id = target_sale AND i.replaced_at IS NULL
       AND (i.number > s.installment_count
            OR i.due_date <> (s.sale_date + make_interval(months => i.number))::date
            OR i.amount_cents <> CASE WHEN i.number = 1 THEN s.total_cents - (s.installment_count - 1) * share ELSE share END)
  ) THEN
    RAISE EXCEPTION 'venda %: número, valor ou vencimento de parcela fora da regra (C52)', target_sale;
  END IF;
  IF s.status = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM public.installments WHERE sale_id = target_sale AND replaced_at IS NULL AND status = 'CANCELED'
  ) THEN
    RAISE EXCEPTION 'venda % válida não pode ter parcela cancelada no cronograma atual', target_sale;
  END IF;
  IF s.status = 'REVERSED' AND EXISTS (
    SELECT 1 FROM public.installments WHERE sale_id = target_sale AND replaced_at IS NULL AND status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'venda % estornada não pode ter parcela em aberto', target_sale;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.installment_schedule_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN
    PERFORM public.assert_installment_schedule(NEW.id);
  ELSE
    PERFORM public.assert_installment_schedule(NEW.sale_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER sales_installment_schedule
  AFTER INSERT OR UPDATE ON public.sales
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.installment_schedule_check();

CREATE CONSTRAINT TRIGGER installments_schedule
  AFTER INSERT OR UPDATE ON public.installments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.installment_schedule_check();

-- -----------------------------------------------------------------------------
-- 4. Cronograma das vendas com cartão já existentes (mesma regra; conferido
--    no COMMIT pelos triggers acima). Venda estornada: parcelas canceladas.
-- -----------------------------------------------------------------------------
INSERT INTO public.installments (sale_id, number, amount_cents, due_date, status)
SELECT s.id,
       g.n,
       CASE WHEN g.n = 1 THEN s.total_cents - (s.installment_count - 1) * (s.total_cents / s.installment_count)
            ELSE s.total_cents / s.installment_count END,
       (s.sale_date + make_interval(months => g.n))::date,
       CASE WHEN s.status = 'ACTIVE' THEN 'OPEN' ELSE 'CANCELED' END::public.installment_status
  FROM public.sales s
 CROSS JOIN LATERAL generate_series(1, s.installment_count) AS g(n)
 WHERE s.payment_method = 'CARD';

-- -----------------------------------------------------------------------------
-- 5. Bloqueio da Data API do Supabase (PostgREST), como no 001–005:
-- RLS ligado SEM políticas + REVOKE para anon/authenticated.
-- -----------------------------------------------------------------------------
ALTER TABLE public.installments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.installments FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.installment_before_write(), public.assert_installment_schedule(uuid),
  public.installment_schedule_check() FROM anon, authenticated, PUBLIC;

COMMIT;
