"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Linha da tabela que abre o lead no drawer. Cliques em botões, links e
 * menus dentro da linha mantêm o próprio comportamento.
 */
export function ClickableRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr
      className="cursor-pointer transition-colors hover:bg-slate-50"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, [role=menu], dialog")) return;
        router.push(href, { scroll: false });
      }}
    >
      {children}
    </tr>
  );
}
