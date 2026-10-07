-- Regras de integridade que não são expressáveis no schema do Drizzle.

-- 1) Auditoria append-only: eventos nunca podem ser alterados ou apagados.
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events é append-only (operação % bloqueada)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint

-- 2) teams.supervisor_id deve apontar para um usuário com papel SUPERVISOR.
CREATE OR REPLACE FUNCTION check_team_supervisor_role() RETURNS trigger AS $$
BEGIN
  IF NEW.supervisor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.supervisor_id AND role = 'SUPERVISOR'
  ) THEN
    RAISE EXCEPTION 'teams.supervisor_id deve referenciar um usuário SUPERVISOR';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER teams_supervisor_role
  BEFORE INSERT OR UPDATE OF supervisor_id ON teams
  FOR EACH ROW EXECUTE FUNCTION check_team_supervisor_role();
--> statement-breakpoint

-- 3) O papel de um usuário é imutável depois de criado. Trocar papel exige
--    regras de negócio ainda não definidas (ver docs/ARQUITETURA.md, Dúvidas).
CREATE OR REPLACE FUNCTION forbid_role_change() RETURNS trigger AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'users.role é imutável';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER users_role_immutable
  BEFORE UPDATE OF role ON users
  FOR EACH ROW EXECUTE FUNCTION forbid_role_change();
