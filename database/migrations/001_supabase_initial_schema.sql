-- =============================================================================
-- 001_supabase_initial_schema.sql
-- CRM Polo Educacional — estrutura inicial no Supabase (PostgreSQL)
--
-- Equivale às migrations Drizzle 0000_foundation, 0001_integrity_triggers e
-- 0002_courses, MAIS o ajuste de instituição em courses (institution_name).
--
-- Executar UMA vez, num projeto Supabase vazio, pelo SQL Editor.
-- Não usa Supabase Auth: autenticação e sessões são próprias da aplicação.
-- Tudo roda numa única transação: se algo falhar, nada é criado.
-- =============================================================================

BEGIN;

-- Extensões: nenhuma. gen_random_uuid() é nativa do PostgreSQL 13+.

-- -----------------------------------------------------------------------------
-- 1. Tipos
-- -----------------------------------------------------------------------------
CREATE TYPE public.user_role AS ENUM ('ADMIN', 'SUPERVISOR', 'SELLER');

-- -----------------------------------------------------------------------------
-- 2. Tabelas (FKs adicionadas na seção 3; users <-> teams se referenciam)
-- -----------------------------------------------------------------------------

-- Equipe comercial. Cada equipe tem no máximo um supervisor.
CREATE TABLE public.teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  name          text NOT NULL,
  supervisor_id uuid,
  active        boolean DEFAULT true NOT NULL,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  updated_at    timestamp with time zone DEFAULT now() NOT NULL
);

-- Usuários. Só vendedores (SELLER) têm team_id.
CREATE TABLE public.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  name          text NOT NULL,
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          public.user_role NOT NULL,
  team_id       uuid,
  active        boolean DEFAULT true NOT NULL,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  updated_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_only_sellers_have_team CHECK (role = 'SELLER' OR team_id IS NULL)
);

-- Sessões de login. id = SHA-256 do token do cookie (o token nunca é gravado).
CREATE TABLE public.sessions (
  id         text PRIMARY KEY NOT NULL,
  user_id    uuid NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  ip_address text,
  user_agent text
);

-- Log central de auditoria (append-only, ver trigger na seção 5).
CREATE TABLE public.audit_events (
  id          bigserial PRIMARY KEY NOT NULL,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL,
  actor_id    uuid,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  team_id     uuid,
  metadata    jsonb DEFAULT '{}'::jsonb NOT NULL
);

-- Curso oferecido por uma instituição. SEM coluna de custo, de propósito.
CREATE TABLE public.courses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  name             text NOT NULL,
  institution_name text NOT NULL,
  active           boolean DEFAULT true NOT NULL,
  created_at       timestamp with time zone DEFAULT now() NOT NULL,
  updated_at       timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT courses_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT courses_institution_not_blank CHECK (btrim(institution_name) <> '')
);

-- Custo da bolsa em centavos (1:1 com o curso). Acesso só do ADMIN (na aplicação).
CREATE TABLE public.course_costs (
  course_id  uuid PRIMARY KEY NOT NULL,
  cost_cents integer NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT course_costs_non_negative CHECK (cost_cents >= 0)
);

-- -----------------------------------------------------------------------------
-- 3. Foreign keys
-- -----------------------------------------------------------------------------
ALTER TABLE public.teams ADD CONSTRAINT teams_supervisor_id_users_id_fk
  FOREIGN KEY (supervisor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.users ADD CONSTRAINT users_team_id_teams_id_fk
  FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.sessions ADD CONSTRAINT sessions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE public.audit_events ADD CONSTRAINT audit_events_actor_id_users_id_fk
  FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.audit_events ADD CONSTRAINT audit_events_team_id_teams_id_fk
  FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.course_costs ADD CONSTRAINT course_costs_course_id_courses_id_fk
  FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.course_costs ADD CONSTRAINT course_costs_updated_by_users_id_fk
  FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- -----------------------------------------------------------------------------
-- 4. Índices
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX users_email_unique ON public.users USING btree (email);
CREATE INDEX users_team_idx ON public.users USING btree (team_id);

CREATE UNIQUE INDEX teams_name_unique ON public.teams USING btree (lower(name));
CREATE UNIQUE INDEX teams_supervisor_unique ON public.teams USING btree (supervisor_id);

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);

CREATE INDEX audit_events_entity_idx ON public.audit_events USING btree (entity_type, entity_id);
CREATE INDEX audit_events_actor_idx ON public.audit_events USING btree (actor_id);
CREATE INDEX audit_events_occurred_idx ON public.audit_events USING btree (occurred_at);

-- Mesmo curso pode existir em instituições diferentes; o par é único
-- (sem diferenciar maiúsculas/minúsculas nem espaços nas pontas).
CREATE UNIQUE INDEX courses_name_institution_unique
  ON public.courses USING btree (lower(btrim(name)), lower(btrim(institution_name)));

-- -----------------------------------------------------------------------------
-- 5. Funções e triggers de integridade
-- -----------------------------------------------------------------------------

-- 5.1 Auditoria append-only: eventos nunca podem ser alterados ou apagados.
CREATE OR REPLACE FUNCTION public.forbid_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'audit_events é append-only (operação % bloqueada)', TG_OP;
END;
$$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.forbid_audit_mutation();

-- 5.2 teams.supervisor_id deve apontar para um usuário com papel SUPERVISOR.
CREATE OR REPLACE FUNCTION public.check_team_supervisor_role() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.supervisor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = NEW.supervisor_id AND role = 'SUPERVISOR'
  ) THEN
    RAISE EXCEPTION 'teams.supervisor_id deve referenciar um usuário SUPERVISOR';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER teams_supervisor_role
  BEFORE INSERT OR UPDATE OF supervisor_id ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.check_team_supervisor_role();

-- 5.3 O papel de um usuário é imutável depois de criado.
CREATE OR REPLACE FUNCTION public.forbid_role_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'users.role é imutável';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_role_immutable
  BEFORE UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.forbid_role_change();

-- 5.4 Cursos e custos nunca são apagados fisicamente (usa-se active).
CREATE OR REPLACE FUNCTION public.forbid_course_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% não permite exclusão física; desative o curso', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER courses_no_delete
  BEFORE DELETE ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.forbid_course_delete();

CREATE TRIGGER course_costs_no_delete
  BEFORE DELETE ON public.course_costs
  FOR EACH ROW EXECUTE FUNCTION public.forbid_course_delete();

-- -----------------------------------------------------------------------------
-- 6. Bloqueio da Data API do Supabase (PostgREST)
--
-- O Supabase expõe o schema public pela API REST para os papéis anon e
-- authenticated. Este CRM não usa essa API: a aplicação conecta direto no
-- Postgres pela DATABASE_URL, como dona das tabelas (o RLS não se aplica a ela).
-- RLS ligado SEM políticas + REVOKE impedem que alguém com a chave pública
-- leia, por exemplo, users.password_hash ou course_costs pela API.
-- -----------------------------------------------------------------------------
ALTER TABLE public.users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_costs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.users, public.teams, public.sessions, public.audit_events,
              public.courses, public.course_costs
  FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.audit_events_id_seq FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.forbid_audit_mutation(), public.check_team_supervisor_role(),
                           public.forbid_role_change(), public.forbid_course_delete()
  FROM anon, authenticated, PUBLIC;

COMMIT;
