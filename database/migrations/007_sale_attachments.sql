-- =============================================================================
-- 007_sale_attachments.sql
-- CRM Polo Educacional — comprovantes de pagamento anexados à venda
--
-- Pré-requisitos: 001 a 006 executados. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é criado.
-- Não altera nenhuma tabela, função ou dado existente.
--
-- Cria: sale_attachments (+ 1 função de trigger).
--
-- O ARQUIVO fica no Cloudflare R2 (bucket privado); aqui ficam só os dados do
-- anexo: venda, chave do objeto no R2, nome original, tipo, tamanho, quem
-- enviou e quando. Vários anexos por venda; anexo opcional (decisão do
-- usuário em 31/10/2026).
--
-- Divisão de responsabilidades:
--   BANCO   — tipo e tamanho permitidos, chave única, sem exclusão física,
--             dados do envio imutáveis; remoção só lógica (removed_at/by),
--             uma única vez.
--   SERVIÇO — RBAC, escopo da venda (C50), validação do conteúdo do arquivo,
--             gravação no R2 e auditoria (audit_events) na mesma transação.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tabela
-- -----------------------------------------------------------------------------
CREATE TABLE public.sale_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  sale_id       uuid NOT NULL,                                     -- imutável
  storage_key   text NOT NULL,                                     -- chave do objeto no R2 (imutável)
  file_name     text NOT NULL,                                     -- nome original do arquivo
  content_type  text NOT NULL,                                     -- conferido pelo conteúdo, não pela extensão
  size_bytes    integer NOT NULL,
  uploaded_by   uuid NOT NULL,                                     -- quem enviou (imutável)
  created_at    timestamp with time zone DEFAULT now() NOT NULL,   -- imutável
  removed_at    timestamp with time zone,                          -- remoção lógica
  removed_by    uuid,
  CONSTRAINT sale_attachments_storage_key_unique UNIQUE (storage_key),
  CONSTRAINT sale_attachments_storage_key_present CHECK (btrim(storage_key) <> '' AND char_length(storage_key) <= 300),
  CONSTRAINT sale_attachments_file_name_present CHECK (btrim(file_name) <> '' AND char_length(file_name) <= 255),
  CONSTRAINT sale_attachments_content_type_allowed CHECK (
    content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  ),
  -- Teto rígido de 5 MB (5 * 1024 * 1024); o limite de negócio fica em business-rules.ts.
  CONSTRAINT sale_attachments_size_range CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  CONSTRAINT sale_attachments_removed_pair CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

-- -----------------------------------------------------------------------------
-- 2. Foreign keys (RESTRICT: nada comercial/histórico é apagado em cascata)
-- -----------------------------------------------------------------------------
ALTER TABLE public.sale_attachments ADD CONSTRAINT sale_attachments_sale_id_sales_id_fk
  FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sale_attachments ADD CONSTRAINT sale_attachments_uploaded_by_users_id_fk
  FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sale_attachments ADD CONSTRAINT sale_attachments_removed_by_users_id_fk
  FOREIGN KEY (removed_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- -----------------------------------------------------------------------------
-- 3. Índices
-- -----------------------------------------------------------------------------
CREATE INDEX sale_attachments_sale_idx ON public.sale_attachments USING btree (sale_id, created_at);

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------
-- Sem exclusão física (reusa forbid_operation do 002).
CREATE TRIGGER sale_attachments_no_delete
  BEFORE DELETE ON public.sale_attachments
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER sale_attachments_no_truncate
  BEFORE TRUNCATE ON public.sale_attachments
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();

-- Os dados do envio são imutáveis; a única mudança permitida é a remoção
-- lógica, uma vez (removed_at/removed_by de NULL para preenchidos).
CREATE OR REPLACE FUNCTION public.check_sale_attachment_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.content_type IS DISTINCT FROM OLD.content_type
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sale_attachments: os dados do envio são imutáveis';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'sale_attachments: anexo removido não pode ser alterado';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sale_attachments_update_guard
  BEFORE UPDATE ON public.sale_attachments
  FOR EACH ROW EXECUTE FUNCTION public.check_sale_attachment_update();

-- -----------------------------------------------------------------------------
-- 5. Bloqueio da Data API do Supabase (PostgREST), como no 001–006:
-- RLS ligado SEM políticas + REVOKE para anon/authenticated.
-- -----------------------------------------------------------------------------
ALTER TABLE public.sale_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sale_attachments FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_sale_attachment_update() FROM anon, authenticated, PUBLIC;

COMMIT;
