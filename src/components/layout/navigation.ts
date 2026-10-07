import type { Actor } from "@/server/authz/actor";
import { hasPermission } from "@/server/authz/permissions";

export type NavIcon =
  | "home"
  | "leads"
  | "kanban"
  | "sales"
  | "installments"
  | "ranking"
  | "certificates"
  | "reports"
  | "team"
  | "users"
  | "courses"
  | "audit";

export type NavItem = { label: string; href: string; icon: NavIcon; soon?: boolean };
export type NavSection = { title?: string; items: NavItem[] };

/**
 * Menu lateral por perfil. Apenas organiza a interface: cada página e Server
 * Action valida permissão no servidor independentemente do menu.
 * Itens `soon` são módulos planejados para as próximas fases.
 */
export function navigationFor(actor: Actor): NavSection[] {
  const commercial: NavItem[] = [
    { label: "Leads", href: "/leads", icon: "leads", soon: true },
    { label: "Kanban", href: "/kanban", icon: "kanban", soon: true },
    { label: "Vendas", href: "/vendas", icon: "sales", soon: true },
    { label: "Parcelas", href: "/parcelas", icon: "installments", soon: true },
    { label: "Ranking", href: "/ranking", icon: "ranking", soon: true },
    { label: "Certificados", href: "/certificados", icon: "certificates", soon: true },
  ];
  if (hasPermission(actor, "reports:export")) {
    commercial.push({ label: "Relatórios", href: "/relatorios", icon: "reports", soon: true });
  }

  const management: NavItem[] = [];
  if (actor.role === "ADMIN") {
    management.push({ label: "Equipes", href: "/equipes", icon: "team" });
  } else if (actor.role === "SUPERVISOR" && actor.supervisedTeamId) {
    management.push({ label: "Minha equipe", href: `/equipes/${actor.supervisedTeamId}`, icon: "team" });
  }
  if (hasPermission(actor, "users:manage")) management.push({ label: "Usuários", href: "/usuarios", icon: "users" });
  if (hasPermission(actor, "courses:manage")) management.push({ label: "Cursos", href: "/cursos", icon: "courses", soon: true });
  if (hasPermission(actor, "audit:view")) management.push({ label: "Auditoria", href: "/auditoria", icon: "audit" });

  const sections: NavSection[] = [
    { items: [{ label: "Início", href: "/", icon: "home" }] },
    { title: "Comercial", items: commercial },
  ];
  if (management.length > 0) sections.push({ title: "Gestão", items: management });
  return sections;
}
