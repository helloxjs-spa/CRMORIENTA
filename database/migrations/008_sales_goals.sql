-- =============================================================================
-- 008_sales_goals.sql
-- CRM Polo Educacional — metas mensais de faturamento ("Resultado do mês")
--
-- Pré-requisitos: 001 a 007 executados. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é criado.
-- Não altera nenhuma tabela, função ou dado existente.
--
-- Cria: sales_goals (+ 1 função de trigger).
--
-- Decisões do usuário (31/10/2026): por mês, uma meta GERAL (time inteiro,
-- seller_id NULL) e uma meta por VENDEDOR, independentes. O ADMIN define a
-- geral e a de qualquer vendedor; o SUPERVISOR, a dos vendedores da equipe
-- que lidera. Todos veem o resultado.
--
-- Divisão de responsabilidades:
--   BANCO   — uma meta geral por mês e uma por vendedor por mês; mês sempre
--             no dia 1; valor positivo em centavos (NULL = meta retirada);
--             meta individual só para SELLER; mês e vendedor imutáveis; sem
--             exclusão física.
--   SERVIÇO — RBAC (goals:setGeneral / goals:setSeller), escopo do supervisor
--             e auditoria (audit_events) na mesma transação.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tabela
-- -----------------------------------------------------------------------------
CREATE TABLE public.sales_goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  month         date NOT NULL,                                     -- dia 1 do mês (imutável)
  seller_id     uuid,                                              -- NULL = meta geral (imutável)
  amount_cents  integer,                                           -- NULL = meta retirada
  created_by    uuid NOT NULL,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  updated_by    uuid NOT NULL,
  updated_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT sales_goals_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT sales_goals_amount_positive CHECK (amount_cents IS NULL OR amount_cents > 0)
);

-- -----------------------------------------------------------------------------
-- 2. Foreign keys (RESTRICT: nada comercial/histórico é apagado em cascata)
-- -----------------------------------------------------------------------------
ALTER TABLE public.sales_goals ADD CONSTRAINT sales_goals_seller_id_users_id_fk
  FOREIGN KEY (seller_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sales_goals ADD CONSTRAINT sales_goals_created_by_users_id_fk
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sales_goals ADD CONSTRAINT sales_goals_updated_by_users_id_fk
  FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- -----------------------------------------------------------------------------
-- 3. Unicidade: uma meta geral por mês; uma meta por vendedor por mês
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX sales_goals_general_month_unique ON public.sales_goals USING btree (month) WHERE seller_id IS NULL;
CREATE UNIQUE INDEX sales_goals_seller_month_unique ON public.sales_goals USING btree (month, seller_id) WHERE seller_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------
-- Sem exclusão física (reusa forbid_operation do 002): retirar a meta = amount_cents NULL.
CREATE TRIGGER sales_goals_no_delete
  BEFORE DELETE ON public.sales_goals
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER sales_goals_no_truncate
  BEFORE TRUNCATE ON public.sales_goals
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();

-- Meta individual só para SELLER; mês, vendedor e criação imutáveis.
CREATE OR REPLACE FUNCTION public.check_sales_goal() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id
     OR NEW.month IS DISTINCT FROM OLD.month
     OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'sales_goals: mês, vendedor e criação são imutáveis';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.seller_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = NEW.seller_id AND role = 'SELLER'
  ) THEN
    RAISE EXCEPTION 'sales_goals.seller_id deve referenciar um usuário SELLER';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_goals_guard
  BEFORE INSERT OR UPDATE ON public.sales_goals
  FOR EACH ROW EXECUTE FUNCTION public.check_sales_goal();

-- -----------------------------------------------------------------------------
-- 5. Bloqueio da Data API do Supabase (PostgREST), como no 001–007:
-- RLS ligado SEM políticas + REVOKE para anon/authenticated.
-- -----------------------------------------------------------------------------
ALTER TABLE public.sales_goals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_goals FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_sales_goal() FROM anon, authenticated, PUBLIC;

COMMIT;
