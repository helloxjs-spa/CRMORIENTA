import type { Actor } from "@/server/authz/actor";
import type { Database } from "@/server/db/types";

/**
 * Contexto recebido por todo serviço de domínio. O ator é obrigatório: não
 * existe caminho para acessar dados de negócio sem um usuário autenticado.
 */
export type ServiceContext = {
  db: Database;
  actor: Actor;
};
