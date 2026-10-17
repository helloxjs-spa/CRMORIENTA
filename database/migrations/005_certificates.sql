-- =============================================================================
-- 005_certificates.sql
-- CRM Polo Educacional — controle operacional de certificados (Documento Mestre §18)
--
-- Pré-requisitos: 001 a 004 executados. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é criado.
-- Não altera nenhuma tabela, função ou dado existente.
--
-- Cria: certificates (+ 1 função de trigger).
--
-- Modelo: um certificado por ITEM de venda (sale_items: uma ocorrência de curso
-- vendido; o mesmo curso repetido na mesma venda são itens distintos). Aluno,
-- curso, vendedor responsável e data da venda NÃO são copiados: vêm do item,
-- da venda e do lead. Aqui ficam só os dados próprios do certificado:
-- conclusão, entrega e certificadora (texto livre, §18).
--
-- Divisão de responsabilidades:
--   BANCO   — um certificado por item, datas coerentes, certificadora não
--             vazia, sem exclusão física, item/autor/data de registro imutáveis.
--   SERVIÇO — RBAC (certificates:operate), escopo (C50: SELLER as próprias
--             vendas; SUPERVISOR os vendedores atualmente na equipe que lidera;
--             ADMIN tudo), quais itens podem receber certificado e auditoria
--             (audit_events) na mesma transação.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tabela
-- -----------------------------------------------------------------------------
CREATE TABLE public.certificates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  sale_item_id  uuid NOT NULL,                                     -- imutável
  completed_on  date NOT NULL,                                     -- data de conclusão do curso
  delivered_on  date NOT NULL,                                     -- data de entrega do certificado
  certifier     text NOT NULL,                                     -- certificadora (texto livre)
  created_by    uuid NOT NULL,                                     -- quem registrou (imutável)
  created_at    timestamp with time zone DEFAULT now() NOT NULL,   -- imutável
  CONSTRAINT certificates_sale_item_unique UNIQUE (sale_item_id),
  CONSTRAINT certificates_certifier_present CHECK (btrim(certifier) <> '' AND char_length(certifier) <= 200),
  CONSTRAINT certificates_delivered_after_completed CHECK (delivered_on >= completed_on)
);

-- -----------------------------------------------------------------------------
-- 2. Foreign keys (RESTRICT: nada comercial/histórico é apagado em cascata)
-- -----------------------------------------------------------------------------
ALTER TABLE public.certificates ADD CONSTRAINT certificates_sale_item_id_sale_items_id_fk
  FOREIGN KEY (sale_item_id) REFERENCES public.sale_items(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.certificates ADD CONSTRAINT certificates_created_by_users_id_fk
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- -----------------------------------------------------------------------------
-- 3. Índices (filtros por período: conclusão e entrega)
-- -----------------------------------------------------------------------------
CREATE INDEX certificates_completed_on_idx ON public.certificates USING btree (completed_on);
CREATE INDEX certificates_delivered_on_idx ON public.certificates USING btree (delivered_on);

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------
-- Sem exclusão física (reusa forbid_operation do 002).
CREATE TRIGGER certificates_no_delete
  BEFORE DELETE ON public.certificates
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER certificates_no_truncate
  BEFORE TRUNCATE ON public.certificates
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();

-- Item, autor e momento do registro são imutáveis. As regras de correção dos
-- demais campos ainda não foram definidas (não há edição na aplicação).
CREATE OR REPLACE FUNCTION public.check_certificate_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.sale_item_id IS DISTINCT FROM OLD.sale_item_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'certificates: id, sale_item_id, created_by e created_at são imutáveis';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER certificates_update_guard
  BEFORE UPDATE ON public.certificates
  FOR EACH ROW EXECUTE FUNCTION public.check_certificate_update();

-- -----------------------------------------------------------------------------
-- 5. Bloqueio da Data API do Supabase (PostgREST), como no 001–004:
-- RLS ligado SEM políticas + REVOKE para anon/authenticated.
-- -----------------------------------------------------------------------------
ALTER TABLE public.certificates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.certificates FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_certificate_update() FROM anon, authenticated, PUBLIC;

COMMIT;
