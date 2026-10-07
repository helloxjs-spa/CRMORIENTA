"use client";

import {
  Award,
  BookOpen,
  Contact,
  CreditCard,
  FileSpreadsheet,
  GraduationCap,
  LayoutDashboard,
  Menu,
  ScrollText,
  ShoppingCart,
  SquareKanban,
  Trophy,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { NavIcon, NavSection } from "./navigation";

const ICONS: Record<NavIcon, LucideIcon> = {
  home: LayoutDashboard,
  leads: Contact,
  kanban: SquareKanban,
  sales: ShoppingCart,
  installments: CreditCard,
  ranking: Trophy,
  certificates: Award,
  reports: FileSpreadsheet,
  team: Users,
  users: UserCog,
  courses: BookOpen,
  audit: ScrollText,
};

export function AppShell({ navigation, header, children }: { navigation: NavSection[]; header: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  // O menu móvel guarda a rota em que foi aberto: ao navegar, fecha sozinho.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const mobileOpen = openedAt === pathname;
  const setMobileOpen = (open: boolean) => setOpenedAt(open ? pathname : null);

  return (
    <div className="min-h-screen">
      {/* Sidebar fixa (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <Sidebar navigation={navigation} pathname={pathname} />
      </aside>

      {/* Sidebar em gaveta (tablet/celular) */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-brand-950/50" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85%] shadow-xl">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-4 rounded-md p-1 text-brand-100 hover:bg-white/10"
              aria-label="Fechar menu"
            >
              <X className="size-5" />
            </button>
            <Sidebar navigation={navigation} pathname={pathname} />
          </div>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            aria-label="Abrir menu"
          >
            <Menu className="size-5" />
          </button>
          <div className="flex flex-1 items-center justify-end gap-3">{header}</div>
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

function Sidebar({ navigation, pathname }: { navigation: NavSection[]; pathname: string }) {
  return (
    <nav className="flex h-full flex-col overflow-y-auto bg-brand-800 px-3 py-4 text-brand-100" aria-label="Navegação principal">
      <Link href="/" className="mb-6 flex items-center gap-2.5 px-3 py-1">
        <span className="flex size-9 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
          <GraduationCap className="size-5 text-white" aria-hidden />
        </span>
        <span className="leading-tight">
          <span className="block text-sm font-semibold text-white">CRM Polo</span>
          <span className="block text-xs text-brand-200">Educacional</span>
        </span>
      </Link>

      <div className="flex-1 space-y-6">
        {navigation.map((section, i) => (
          <div key={section.title ?? i}>
            {section.title && (
              <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-brand-300">{section.title}</p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = ICONS[item.icon];
                const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
                if (item.soon) {
                  return (
                    <li key={item.href}>
                      <span
                        className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-brand-300/70"
                        title="Disponível nas próximas fases"
                      >
                        <Icon className="size-4.5 shrink-0" aria-hidden />
                        <span className="flex-1">{item.label}</span>
                        <span className="rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-brand-300">em breve</span>
                      </span>
                    </li>
                  );
                }
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        active ? "bg-white/12 text-white shadow-inner ring-1 ring-white/10" : "hover:bg-white/5 hover:text-white",
                      )}
                    >
                      <Icon className="size-4.5 shrink-0" aria-hidden />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
