"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

/**
 * Painel lateral cujo estado de aberto vive na URL: fechar navega para
 * `closeHref` (sem o parâmetro que o abriu). No celular ocupa a tela inteira.
 */
export function Drawer({ closeHref, label, children }: { closeHref: string; label: string; children: ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const close = () => router.replace(closeHref, { scroll: false });
    const onKey = (e: KeyboardEvent) => {
      // Esc dentro de um modal aberto fecha só o modal.
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) close();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [closeHref, router]);

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={label}>
      <div className="absolute inset-0 bg-brand-950/40" onClick={() => router.replace(closeHref, { scroll: false })} aria-hidden />
      <div className="absolute inset-y-0 right-0 flex w-full flex-col bg-white shadow-2xl sm:max-w-xl [animation:drawer-in_.18s_ease-out]">
        <button
          type="button"
          onClick={() => router.replace(closeHref, { scroll: false })}
          className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          aria-label="Fechar"
        >
          <X className="size-5" />
        </button>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
