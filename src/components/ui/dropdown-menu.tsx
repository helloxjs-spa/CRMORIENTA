"use client";

import type { LucideIcon } from "lucide-react";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export type MenuItem = { label: string; icon?: LucideIcon; onSelect: () => void; tone?: "default" | "danger" };

const GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * Menu de ações contextual (botão "⋯"). Fecha ao clicar fora, com Esc, ao rolar
 * ou redimensionar. O menu é renderizado num portal com posição fixa, para não
 * ser cortado por contêineres com overflow (tabelas, colunas do Kanban); abre
 * para cima quando não cabe abaixo do botão.
 */
export function DropdownMenu({ items, label = "Ações", className }: { items: MenuItem[]; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!button || !menu) return;
    const fitsBelow = button.bottom + GAP + menu.height <= window.innerHeight - VIEWPORT_MARGIN;
    const top = fitsBelow ? button.bottom + GAP : Math.max(VIEWPORT_MARGIN, button.top - GAP - menu.height);
    const left = Math.min(Math.max(VIEWPORT_MARGIN, button.right - menu.width), window.innerWidth - VIEWPORT_MARGIN - menu.width);
    setStyle({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // Rolagem dentro do próprio menu não fecha; qualquer outra deslocaria o botão.
    const onScroll = (e: Event) => !menuRef.current?.contains(e.target as Node) && close();
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (items.length === 0) return null;

  const toggle = () => {
    setStyle({ visibility: "hidden" });
    setOpen((v) => !v);
  };

  return (
    <div className={cn("relative", className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-brand-600"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            style={style}
            className="fixed z-50 w-52 overflow-hidden rounded-xl bg-white py-1 shadow-lg ring-1 ring-slate-200"
          >
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm",
                    item.tone === "danger" ? "text-red-600 hover:bg-red-50" : "text-slate-700 hover:bg-slate-50",
                  )}
                >
                  {Icon && <Icon className="size-4" aria-hidden />}
                  {item.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
