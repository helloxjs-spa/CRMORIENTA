"use client";

import { Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { STAGE_LABELS, STAGE_ORDER } from "@/lib/leads";
import type { LeadStage } from "@/server/db/schema";
import { hasResultFilters, leadsHref, type LeadsParams } from "./search-params";

export type FilterOption = { id: string; label: string };

export type ToolbarOptions = {
  stages: boolean;
  courses: FilterOption[];
  sellers?: FilterOption[];
  teams?: FilterOption[];
};

const selectClasses =
  "h-10 w-full rounded-lg border-0 bg-white px-3 pr-8 text-sm text-slate-800 shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600 md:w-auto md:max-w-52";

/**
 * Busca e filtros da tela de Leads. Todo o estado fica na URL (a página do
 * servidor relê os parâmetros e consulta o banco já paginado).
 */
export function LeadsToolbar({ params, options }: { params: LeadsParams; options: ToolbarOptions }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Busca: estado local para digitar sem esperar a navegação, ressincronizado
  // quando a URL muda por outro motivo (ex.: "Limpar filtros").
  const [query, setQuery] = useState(params.q ?? "");
  const [syncedQuery, setSyncedQuery] = useState(params.q);
  if (params.q !== syncedQuery) {
    setSyncedQuery(params.q);
    setQuery(params.q ?? "");
  }

  const navigate = (overrides: Partial<LeadsParams>) => {
    // Qualquer mudança de filtro volta para a página 1 e fecha o drawer.
    startTransition(() => router.replace(leadsHref(params, { page: 1, lead: undefined, ...overrides }), { scroll: false }));
  };

  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(debounce.current), []);
  const onSearchChange = (value: string) => {
    setQuery(value);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => navigate({ q: value.trim() || undefined }), 400);
  };

  const activeFilters = [params.stage, params.course, params.seller, params.team].filter(Boolean).length;
  const showStage = options.stages && params.view !== "lixeira";

  const selects = (
    <>
      {showStage && (
        <select
          aria-label="Etapa"
          className={selectClasses}
          value={params.stage ?? ""}
          onChange={(e) => navigate({ stage: (e.target.value || undefined) as LeadStage | undefined })}
        >
          <option value="">Todas as etapas</option>
          {STAGE_ORDER.map((stage) => (
            <option key={stage} value={stage}>
              {STAGE_LABELS[stage]}
            </option>
          ))}
        </select>
      )}
      <select aria-label="Curso" className={selectClasses} value={params.course ?? ""} onChange={(e) => navigate({ course: e.target.value || undefined })}>
        <option value="">Todos os cursos</option>
        {options.courses.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      {options.teams && (
        <select
          aria-label="Equipe"
          className={selectClasses}
          value={params.team ?? ""}
          onChange={(e) => navigate({ team: e.target.value || undefined })}
        >
          <option value="">Todas as equipes</option>
          {options.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      )}
      {options.sellers && (
        <select
          aria-label="Vendedor"
          className={selectClasses}
          value={params.seller ?? ""}
          onChange={(e) => navigate({ seller: e.target.value || undefined })}
        >
          <option value="">Todos os vendedores</option>
          {options.sellers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      )}
    </>
  );

  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <form
          role="search"
          className="relative min-w-0 flex-1 md:max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            clearTimeout(debounce.current);
            navigate({ q: query.trim() || undefined });
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Buscar por nome ou telefone..."
            aria-label="Buscar por nome ou telefone"
            className="h-10 w-full rounded-lg border-0 bg-white pl-9 pr-9 text-sm shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-600"
          />
          {pending && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-slate-400" aria-label="Carregando" />}
        </form>

        <div className="hidden flex-wrap items-center gap-2 md:flex">{selects}</div>

        <Button variant="secondary" className="md:hidden" onClick={() => setSheetOpen(true)}>
          <SlidersHorizontal className="size-4" aria-hidden />
          Filtros{activeFilters > 0 ? ` (${activeFilters})` : ""}
        </Button>

        {hasResultFilters(params) && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              navigate({ q: undefined, stage: undefined, course: undefined, seller: undefined, team: undefined });
            }}
            className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
          >
            <X className="size-3.5" aria-hidden />
            Limpar filtros
          </button>
        )}
      </div>

      {/* Filtros no celular: painel inferior */}
      {sheetOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Filtros">
          <div className="absolute inset-0 bg-brand-950/40" onClick={() => setSheetOpen(false)} aria-hidden />
          <div className="absolute inset-x-0 bottom-0 space-y-3 rounded-t-2xl bg-white p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">Filtros</h2>
              <button type="button" onClick={() => setSheetOpen(false)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100" aria-label="Fechar">
                <X className="size-5" />
              </button>
            </div>
            <div className={cn("flex flex-col gap-3", pending && "opacity-70")}>{selects}</div>
            <Button className="w-full" onClick={() => setSheetOpen(false)}>
              Ver resultados
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
