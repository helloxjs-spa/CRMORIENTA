-- =============================================================================
-- 002_leads.sql
-- CRM Polo Educacional — fundação do módulo de Leads
--
-- Pré-requisito: 001_supabase_initial_schema.sql já executado.
-- Executar UMA vez, pelo SQL Editor do Supabase.
-- Não altera nem remove nada do 001. Cria tabelas, tipos, funções e triggers
-- novos; o único objeto ligado a uma tabela do 001 é um trigger novo em
-- public.users (seção 5.4), que mantém os leads abertos coerentes quando um
-- vendedor é desativado ou muda de equipe.
-- Tudo roda numa única transação: se algo falhar, nada é criado.
--
-- Modelo (detalhes em docs/ARQUITETURA.md, seção Kanban):
--   leads        -> o lead e sua situação ATUAL (etapa, situação, responsável, equipe)
--   lead_cycles  -> ciclos de atendimento (1 = inicial; 2, 3... = retrabalho)
--   lead_notes   -> observações append-only (autor, contexto, conteúdo, data/hora)
--   lead_events  -> linha do tempo append-only, com retrato de responsável,
--                   equipe, supervisor, etapa e ciclo no momento de cada fato
--
-- Prazos NÃO são calculados aqui: a aplicação grava stage_due_at (valores em
-- src/server/config/business-rules.ts) e "vencido" é derivado de
-- stage_due_at < agora. Sem cron.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tipos
-- -----------------------------------------------------------------------------

-- Etapa do funil (colunas do Kanban, exceto Lixeira, que é situação).
CREATE TYPE public.lead_stage AS ENUM (
  'NEW',          -- Lead Cadastrado
  'NO_ANSWER',    -- Não Respondeu (manual, sem prazo)
  'FOLLOW_UP_1',  -- prazo
  'FOLLOW_UP_2',  -- prazo
  'FOLLOW_UP_3',  -- prazo; vencido -> fila de decisão do supervisor
  'NEGOTIATION',  -- Em Negociação; prazo renovado a cada observação
  'CLOSED',       -- Fechamento (alcançado somente com a criação da venda)
  'REWORK'        -- Retrabalho (etapa visível, sem prazo)
);

-- Situação do lead. Lixeira NÃO é exclusão: registro, etapa e telefone ficam.
CREATE TYPE public.lead_status AS ENUM ('ACTIVE', 'TRASHED');

-- Por que o lead ficou sem vendedor responsável (fila do supervisor).
CREATE TYPE public.lead_unassigned_reason AS ENUM ('OWNER_DEACTIVATED');

-- Tipo do ciclo de atendimento.
CREATE TYPE public.lead_cycle_kind AS ENUM ('INITIAL', 'REWORK');

-- Motivo de encerramento de um ciclo.
CREATE TYPE public.lead_cycle_end_reason AS ENUM (
  'REDISTRIBUTED', -- nova tentativa comercial com outro vendedor (abre ciclo REWORK)
  'TRASHED',       -- enviado para a Lixeira
  'WON'            -- venda registrada (fase Vendas)
);

-- Fatos da linha do tempo do lead.
CREATE TYPE public.lead_event_type AS ENUM (
  'CREATED',
  'DETAILS_UPDATED',  -- nome, telefone ou curso de interesse (de/para em metadata)
  'STAGE_CHANGED',
  'TRANSFERRED',      -- novo responsável; mantém etapa e ciclo (inclui a atribuição a partir da fila)
  'TEAM_CHANGED',     -- o responsável mudou de equipe e o lead o acompanhou
  'UNASSIGNED',       -- o lead ficou sem responsável (motivo em unassigned_reason)
  'REDISTRIBUTED',    -- novo ciclo REWORK com o vendedor escolhido
  'TRASHED',
  'RESTORED',         -- recuperado da Lixeira: novo ciclo REWORK com o vendedor escolhido
  'NOTE_ADDED'
);

-- -----------------------------------------------------------------------------
-- 2. Tabelas
-- -----------------------------------------------------------------------------

-- Lead. O telefone é a identidade: único para sempre, inclusive na Lixeira.
CREATE TABLE public.leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  name               text NOT NULL,
  -- Telefone CANÔNICO, só dígitos: 55 + DDD + número.
  --   celular: 9 dígitos começando em 9   -> 5579999999999
  --   fixo:    8 dígitos começando em 2-5 -> 557932110000
  -- A formatação "(79) 99999-9999" é feita na interface a partir deste valor.
  phone              text NOT NULL,
  interest_course_id uuid NOT NULL,
  -- Vendedor responsável. NULL = aguardando decisão do supervisor
  -- (unassigned_at/unassigned_reason preenchidos).
  owner_id           uuid,
  -- Equipe ATUAL do lead: define qual supervisor o enxerga. Sempre preenchida,
  -- inclusive sem responsável (é a fila em que o lead aguarda).
  -- O supervisor atual é o supervisor da equipe (teams.supervisor_id).
  team_id            uuid NOT NULL,
  unassigned_at      timestamp with time zone,
  unassigned_reason  public.lead_unassigned_reason,
  stage              public.lead_stage DEFAULT 'NEW' NOT NULL,
  stage_entered_at   timestamp with time zone DEFAULT now() NOT NULL,
  -- Prazo da etapa atual: existe somente em Follow-up 1/2/3 e Em Negociação.
  stage_due_at       timestamp with time zone,
  status             public.lead_status DEFAULT 'ACTIVE' NOT NULL,
  trashed_at         timestamp with time zone,
  trashed_by         uuid,
  -- created_at = data de cadastro (hora do servidor, imutável).
  created_by         uuid NOT NULL,
  created_at         timestamp with time zone DEFAULT now() NOT NULL,
  updated_at         timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT leads_name_not_blank CHECK (btrim(name) <> ''),
  -- 55 + DDD válido (lista oficial da Anatel) + celular com 9º dígito ou fixo.
  CONSTRAINT leads_phone_canonical CHECK (
    phone ~ '^55(1[1-9]|2[12478]|3[1234578]|4[1-9]|5[1345]|6[1-9]|7[134579]|8[1-9]|9[1-9])(9[0-9]{8}|[2-5][0-9]{7})$'
  ),
  CONSTRAINT leads_stage_due_consistent CHECK (
    (stage IN ('FOLLOW_UP_1', 'FOLLOW_UP_2', 'FOLLOW_UP_3', 'NEGOTIATION')) = (stage_due_at IS NOT NULL)
  ),
  CONSTRAINT leads_stage_due_after_entry CHECK (stage_due_at IS NULL OR stage_due_at > stage_entered_at),
  CONSTRAINT leads_trash_consistent CHECK (
    (status = 'TRASHED') = (trashed_at IS NOT NULL)
    AND (trashed_at IS NULL) = (trashed_by IS NULL)
  ),
  CONSTRAINT leads_unassigned_consistent CHECK (
    (owner_id IS NULL) = (unassigned_at IS NOT NULL)
    AND (unassigned_at IS NULL) = (unassigned_reason IS NULL)
  ),
  -- Lead fechado (com venda) sempre tem o vendedor que fechou.
  CONSTRAINT leads_closed_has_owner CHECK (stage <> 'CLOSED' OR owner_id IS NOT NULL)
);

-- Ciclo de atendimento (tentativa comercial). Permite distinguir, por exemplo,
-- o Follow-up 1 do primeiro atendimento do Follow-up 1 de um retrabalho.
-- Ciclo atual = o ciclo ABERTO (ended_at IS NULL); no máximo um por lead.
CREATE TABLE public.lead_cycles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  lead_id            uuid NOT NULL,
  number             integer NOT NULL,
  kind               public.lead_cycle_kind NOT NULL,
  -- Vendedor que recebeu o ciclo e a equipe dele naquele momento (retrato).
  -- Transferências no meio do ciclo ficam em lead_events (TRANSFERRED).
  assigned_seller_id uuid NOT NULL,
  team_id            uuid NOT NULL,
  started_at         timestamp with time zone DEFAULT now() NOT NULL,
  started_by         uuid NOT NULL,
  ended_at           timestamp with time zone,
  ended_by           uuid,
  end_reason         public.lead_cycle_end_reason,
  CONSTRAINT lead_cycles_number_positive CHECK (number >= 1),
  CONSTRAINT lead_cycles_kind_matches_number CHECK ((number = 1) = (kind = 'INITIAL')),
  CONSTRAINT lead_cycles_end_consistent CHECK (
    (ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL)
    OR (ended_at IS NOT NULL AND ended_by IS NOT NULL AND end_reason IS NOT NULL AND ended_at >= started_at)
  ),
  -- Alvo das FKs compostas: nota e evento apontam para um ciclo do MESMO lead.
  CONSTRAINT lead_cycles_lead_id_id_unique UNIQUE (lead_id, id),
  CONSTRAINT lead_cycles_lead_number_unique UNIQUE (lead_id, number)
);

-- Observação / atualização de negociação. Append-only.
-- Contexto: ciclo e etapa em que foi registrada.
CREATE TABLE public.lead_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  lead_id    uuid NOT NULL,
  cycle_id   uuid NOT NULL,
  stage      public.lead_stage NOT NULL,
  author_id  uuid NOT NULL,
  body       text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT lead_notes_body_not_blank CHECK (btrim(body) <> ''),
  CONSTRAINT lead_notes_lead_id_id_unique UNIQUE (lead_id, id)
);

-- Linha do tempo do lead (append-only). Cada linha guarda o retrato DEPOIS do
-- fato (ciclo, etapa, responsável, equipe, supervisor) e, quando houver
-- mudança, o valor anterior em from_*. Nunca é reescrita.
-- audit_events continua sendo a auditoria global; esta tabela não a substitui.
CREATE TABLE public.lead_events (
  id                 bigserial PRIMARY KEY NOT NULL,
  lead_id            uuid NOT NULL,
  cycle_id           uuid NOT NULL,
  type               public.lead_event_type NOT NULL,
  occurred_at        timestamp with time zone DEFAULT now() NOT NULL,
  actor_id           uuid NOT NULL,
  stage              public.lead_stage NOT NULL,
  from_stage         public.lead_stage,
  owner_id           uuid,
  from_owner_id      uuid,
  team_id            uuid NOT NULL,
  from_team_id       uuid,
  supervisor_id      uuid,
  from_supervisor_id uuid,
  unassigned_reason  public.lead_unassigned_reason,
  note_id            uuid,
  metadata           jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT lead_events_created CHECK (
    type <> 'CREATED' OR (owner_id IS NOT NULL AND stage = 'NEW')
  ),
  CONSTRAINT lead_events_stage_change CHECK (
    type <> 'STAGE_CHANGED' OR (from_stage IS NOT NULL AND from_stage <> stage)
  ),
  CONSTRAINT lead_events_transfer CHECK (
    type <> 'TRANSFERRED' OR (owner_id IS NOT NULL AND from_owner_id IS DISTINCT FROM owner_id)
  ),
  CONSTRAINT lead_events_team_change CHECK (
    type <> 'TEAM_CHANGED' OR (from_team_id IS NOT NULL AND from_team_id <> team_id)
  ),
  CONSTRAINT lead_events_unassigned CHECK (
    (type = 'UNASSIGNED') = (unassigned_reason IS NOT NULL)
    AND (type <> 'UNASSIGNED' OR (owner_id IS NULL AND from_owner_id IS NOT NULL))
  ),
  CONSTRAINT lead_events_new_cycle CHECK (
    type NOT IN ('REDISTRIBUTED', 'RESTORED') OR (owner_id IS NOT NULL AND stage = 'REWORK')
  ),
  CONSTRAINT lead_events_note CHECK (type <> 'NOTE_ADDED' OR note_id IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- 3. Foreign keys (todas RESTRICT: nada de negócio é apagado em cascata).
-- Não há referência circular: leads não aponta para lead_cycles.
-- -----------------------------------------------------------------------------
ALTER TABLE public.leads ADD CONSTRAINT leads_interest_course_id_courses_id_fk
  FOREIGN KEY (interest_course_id) REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.leads ADD CONSTRAINT leads_owner_id_users_id_fk
  FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.leads ADD CONSTRAINT leads_team_id_teams_id_fk
  FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.leads ADD CONSTRAINT leads_trashed_by_users_id_fk
  FOREIGN KEY (trashed_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.leads ADD CONSTRAINT leads_created_by_users_id_fk
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.lead_cycles ADD CONSTRAINT lead_cycles_lead_id_leads_id_fk
  FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_cycles ADD CONSTRAINT lead_cycles_assigned_seller_id_users_id_fk
  FOREIGN KEY (assigned_seller_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_cycles ADD CONSTRAINT lead_cycles_team_id_teams_id_fk
  FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_cycles ADD CONSTRAINT lead_cycles_started_by_users_id_fk
  FOREIGN KEY (started_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_cycles ADD CONSTRAINT lead_cycles_ended_by_users_id_fk
  FOREIGN KEY (ended_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.lead_notes ADD CONSTRAINT lead_notes_cycle_fk
  FOREIGN KEY (lead_id, cycle_id) REFERENCES public.lead_cycles(lead_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_notes ADD CONSTRAINT lead_notes_author_id_users_id_fk
  FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_cycle_fk
  FOREIGN KEY (lead_id, cycle_id) REFERENCES public.lead_cycles(lead_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_note_fk
  FOREIGN KEY (lead_id, note_id) REFERENCES public.lead_notes(lead_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_actor_id_users_id_fk
  FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_owner_id_users_id_fk
  FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_from_owner_id_users_id_fk
  FOREIGN KEY (from_owner_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_team_id_teams_id_fk
  FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_from_team_id_teams_id_fk
  FOREIGN KEY (from_team_id) REFERENCES public.teams(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_supervisor_id_users_id_fk
  FOREIGN KEY (supervisor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_from_supervisor_id_users_id_fk
  FOREIGN KEY (from_supervisor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- -----------------------------------------------------------------------------
-- 4. Unicidade e índices
-- -----------------------------------------------------------------------------

-- Telefone único para TODOS os leads (ativos e na Lixeira), garantido pelo
-- PostgreSQL: de dois cadastros simultâneos do mesmo telefone, um recebe o
-- erro 23505 nesta constraint, independentemente da aplicação.
ALTER TABLE public.leads ADD CONSTRAINT leads_phone_unique UNIQUE (phone);

-- Kanban do vendedor e da equipe.
CREATE INDEX leads_owner_status_stage_idx ON public.leads USING btree (owner_id, status, stage);
CREATE INDEX leads_team_status_stage_idx ON public.leads USING btree (team_id, status, stage);
-- Filtros por período de cadastro.
CREATE INDEX leads_created_at_idx ON public.leads USING btree (created_at);
-- Negociações vencidas de um vendedor (bloqueio): owner + stage_due_at < agora.
CREATE INDEX leads_negotiation_due_idx ON public.leads USING btree (owner_id, stage_due_at)
  WHERE stage = 'NEGOTIATION' AND status = 'ACTIVE';
-- Fila do supervisor: Follow-up 3 vencido (team + stage_due_at < agora).
CREATE INDEX leads_follow_up_3_due_idx ON public.leads USING btree (team_id, stage_due_at)
  WHERE stage = 'FOLLOW_UP_3' AND status = 'ACTIVE';
-- Fila do supervisor: leads sem responsável.
CREATE INDEX leads_unassigned_idx ON public.leads USING btree (team_id, unassigned_at)
  WHERE owner_id IS NULL AND status = 'ACTIVE';

-- No máximo um ciclo ABERTO por lead (o ciclo atual).
CREATE UNIQUE INDEX lead_cycles_one_open_per_lead ON public.lead_cycles USING btree (lead_id) WHERE ended_at IS NULL;
CREATE INDEX lead_cycles_assigned_seller_idx ON public.lead_cycles USING btree (assigned_seller_id);

CREATE INDEX lead_notes_lead_created_idx ON public.lead_notes USING btree (lead_id, created_at);

CREATE INDEX lead_events_lead_occurred_idx ON public.lead_events USING btree (lead_id, occurred_at);
CREATE INDEX lead_events_team_occurred_idx ON public.lead_events USING btree (team_id, occurred_at);
CREATE INDEX lead_events_actor_idx ON public.lead_events USING btree (actor_id);

-- -----------------------------------------------------------------------------
-- 5. Funções e triggers de integridade
-- -----------------------------------------------------------------------------

-- 5.1 Bloqueio genérico: sem exclusão física; notas e eventos append-only.
CREATE OR REPLACE FUNCTION public.forbid_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'operação % não permitida em % (registros de negócio não são apagados nem reescritos)', TG_OP, TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER leads_no_delete
  BEFORE DELETE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER lead_cycles_no_delete
  BEFORE DELETE ON public.lead_cycles
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER lead_notes_append_only
  BEFORE UPDATE OR DELETE ON public.lead_notes
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER lead_events_append_only
  BEFORE UPDATE OR DELETE ON public.lead_events
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();

-- TRUNCATE não dispara triggers de linha: bloqueado à parte.
CREATE TRIGGER leads_no_truncate
  BEFORE TRUNCATE ON public.leads
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER lead_cycles_no_truncate
  BEFORE TRUNCATE ON public.lead_cycles
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER lead_notes_no_truncate
  BEFORE TRUNCATE ON public.lead_notes
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER lead_events_no_truncate
  BEFORE TRUNCATE ON public.lead_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();

-- 5.2 Integridade do lead (a cada INSERT/UPDATE):
--   - created_at/created_by imutáveis;
--   - o lead nasce com responsável;
--   - sem responsável, o lead fica na fila da MESMA equipe (team_id não muda
--     sem que um vendedor seja atribuído);
--   - lead em operação (ACTIVE e não fechado) com responsável: o responsável
--     é um SELLER ativo e team_id é a equipe atual dele.
--     A linha do vendedor é lida com FOR SHARE: uma desativação ou troca de
--     equipe concorrente espera esta gravação terminar.
CREATE OR REPLACE FUNCTION public.check_lead_integrity() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  owner_role   public.user_role;
  owner_active boolean;
  owner_team   uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.created_at IS DISTINCT FROM OLD.created_at
                           OR NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
    RAISE EXCEPTION 'leads.created_at e leads.created_by são imutáveis';
  END IF;

  IF NEW.owner_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'o lead deve ser cadastrado com um vendedor responsável';
    END IF;
    IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RAISE EXCEPTION 'lead sem responsável permanece na fila da sua equipe; atribua um vendedor para mudar de equipe';
    END IF;
  ELSIF NEW.status = 'ACTIVE' AND NEW.stage <> 'CLOSED' THEN
    SELECT role, active, team_id INTO owner_role, owner_active, owner_team
      FROM public.users WHERE id = NEW.owner_id FOR SHARE;
    IF owner_role IS DISTINCT FROM 'SELLER' THEN
      RAISE EXCEPTION 'leads.owner_id deve referenciar um usuário SELLER';
    END IF;
    IF NOT owner_active THEN
      RAISE EXCEPTION 'leads.owner_id deve referenciar um vendedor ativo';
    END IF;
    IF owner_team IS DISTINCT FROM NEW.team_id THEN
      RAISE EXCEPTION 'leads.team_id deve ser a equipe atual do vendedor responsável';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER leads_integrity
  BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.check_lead_integrity();

-- 5.3 Ciclo: identificação e abertura imutáveis; o encerramento é gravado uma
-- única vez e, depois disso, o ciclo não muda mais.
CREATE OR REPLACE FUNCTION public.check_lead_cycle_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'lead_cycles: ciclo encerrado é imutável';
  END IF;
  IF NEW.lead_id IS DISTINCT FROM OLD.lead_id
     OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.assigned_seller_id IS DISTINCT FROM OLD.assigned_seller_id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.started_by IS DISTINCT FROM OLD.started_by THEN
    RAISE EXCEPTION 'lead_cycles: só os campos de encerramento podem ser preenchidos';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lead_cycles_update_guard
  BEFORE UPDATE ON public.lead_cycles
  FOR EACH ROW EXECUTE FUNCTION public.check_lead_cycle_update();

-- 5.4 Vendedor desativado ou que mudou de equipe (trigger em users, verificado
-- no COMMIT): nenhum lead em operação pode continuar com ele se estiver
-- inativo, nem numa equipe diferente da dele. A desativação NÃO é impedida:
-- na mesma transação a aplicação deixa os leads sem responsável (fila do
-- supervisor); na troca de equipe, leva os leads junto (decisão C4).
CREATE OR REPLACE FUNCTION public.check_seller_open_leads() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  seller_active boolean;
  seller_team   uuid;
BEGIN
  IF NEW.role <> 'SELLER' THEN
    RETURN NULL;
  END IF;
  SELECT active, team_id INTO seller_active, seller_team FROM public.users WHERE id = NEW.id;
  IF EXISTS (
    SELECT 1 FROM public.leads
     WHERE owner_id = NEW.id AND status = 'ACTIVE' AND stage <> 'CLOSED'
       AND (NOT seller_active OR team_id IS DISTINCT FROM seller_team)
  ) THEN
    RAISE EXCEPTION 'vendedor com leads em operação: ao desativar, deixe os leads sem responsável; ao trocar de equipe, mova os leads junto';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER users_seller_open_leads
  AFTER UPDATE OF active, team_id ON public.users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_seller_open_leads();

-- 5.5 Coerência lead x ciclos (verificada no COMMIT, por isso lead e ciclo 1
-- podem ser inseridos em sequência na mesma transação):
--   - todo lead tem pelo menos um ciclo;
--   - lead em operação (ACTIVE e não fechado) tem exatamente um ciclo aberto,
--     e ele é o mais recente;
--   - lead na Lixeira ou fechado não tem ciclo aberto.
CREATE OR REPLACE FUNCTION public.check_lead_cycle_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  target_lead  uuid;
  lead_status  public.lead_status;
  lead_stage   public.lead_stage;
  open_count   integer;
  open_number  integer;
  last_number  integer;
BEGIN
  IF TG_TABLE_NAME = 'leads' THEN
    target_lead := NEW.id;
  ELSE
    target_lead := NEW.lead_id;
  END IF;

  SELECT status, stage INTO lead_status, lead_stage FROM public.leads WHERE id = target_lead;
  SELECT count(*) FILTER (WHERE ended_at IS NULL),
         max(number) FILTER (WHERE ended_at IS NULL),
         max(number)
    INTO open_count, open_number, last_number
    FROM public.lead_cycles WHERE lead_id = target_lead;

  IF last_number IS NULL THEN
    RAISE EXCEPTION 'lead % sem ciclo de atendimento', target_lead;
  END IF;
  IF lead_status = 'ACTIVE' AND lead_stage <> 'CLOSED' THEN
    IF open_count = 0 THEN
      RAISE EXCEPTION 'lead % em operação precisa de um ciclo aberto', target_lead;
    END IF;
    IF open_number <> last_number THEN
      RAISE EXCEPTION 'lead %: o ciclo aberto deve ser o mais recente', target_lead;
    END IF;
  ELSIF open_count > 0 THEN
    RAISE EXCEPTION 'lead % na Lixeira ou fechado não pode ter ciclo aberto', target_lead;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER leads_cycle_state
  AFTER INSERT OR UPDATE OF status, stage ON public.leads
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_lead_cycle_state();

CREATE CONSTRAINT TRIGGER lead_cycles_cycle_state
  AFTER INSERT OR UPDATE ON public.lead_cycles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_lead_cycle_state();

-- -----------------------------------------------------------------------------
-- 6. Bloqueio da Data API do Supabase (PostgREST), como no 001:
-- RLS ligado SEM políticas + REVOKE para anon/authenticated.
-- -----------------------------------------------------------------------------
ALTER TABLE public.leads       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_notes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.leads, public.lead_cycles, public.lead_notes, public.lead_events
  FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.lead_events_id_seq FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.forbid_operation(), public.check_lead_integrity(),
                           public.check_lead_cycle_update(), public.check_seller_open_leads(),
                           public.check_lead_cycle_state()
  FROM anon, authenticated, PUBLIC;

COMMIT;
