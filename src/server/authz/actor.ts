import type { UserRole } from "@/server/db/schema";

/**
 * Usuário autenticado que executa uma operação. É sempre carregado do banco a
 * cada requisição (nunca do cliente), para que mudanças de equipe, papel ou
 * desativação tenham efeito imediato.
 */
export type Actor = {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  /** Equipe do vendedor (apenas SELLER). */
  teamId: string | null;
  /** Equipe liderada (apenas SUPERVISOR). */
  supervisedTeamId: string | null;
};

