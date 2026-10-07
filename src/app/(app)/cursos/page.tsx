import type { Metadata } from "next";
import { BookOpen, Search } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-button";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { formatBRL } from "@/lib/money";
import { hasPermission } from "@/server/authz/permissions";
import { listCoursesWithCost } from "@/server/modules/courses/courses.service";
import { requireServiceContext } from "@/server/next/session";
import { setCourseActiveAction } from "./actions";
import { CreateCourseDialog, EditCourseDialog } from "./course-dialogs";

export const metadata: Metadata = { title: "Cursos" };

const filterInput =
  "h-10 rounded-lg border-0 bg-white px-3 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600";

/** Tela de gestão de cursos — exclusiva do ADMIN, pois exibe o custo da bolsa. */
export default async function CoursesPage({ searchParams }: PageProps<"/cursos">) {
  const ctx = await requireServiceContext();
  if (!hasPermission(ctx.actor, "courses:viewCost")) notFound();

  const { q, status } = await searchParams;
  const search = typeof q === "string" && q.trim() ? q.trim() : undefined;
  const statusFilter = status === "ativos" || status === "inativos" ? status : undefined;
  const list = await listCoursesWithCost(ctx, {
    search,
    active: statusFilter === "ativos" ? true : statusFilter === "inativos" ? false : undefined,
  });
  const hasFilters = !!(search || statusFilter);

  return (
    <>
      <PageHeader
        title="Cursos"
        description="Cursos oferecidos e custo da bolsa. O custo é visível somente para administradores."
        actions={<CreateCourseDialog />}
      />

      <form className="mb-4 flex flex-wrap items-center gap-2" role="search">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input name="q" defaultValue={search} placeholder="Buscar curso" className={`${filterInput} w-full pl-9`} aria-label="Buscar curso" />
        </div>
        <select name="status" defaultValue={statusFilter ?? ""} className={filterInput} aria-label="Status">
          <option value="">Todos os status</option>
          <option value="ativos">Ativos</option>
          <option value="inativos">Inativos</option>
        </select>
        <button type="submit" className={buttonClasses({ variant: "secondary" })}>
          Filtrar
        </button>
        {hasFilters && (
          <Link href="/cursos" className="text-sm text-slate-500 hover:text-slate-800">
            Limpar
          </Link>
        )}
      </form>

      <Card>
        {list.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title={hasFilters ? "Nenhum curso encontrado" : "Nenhum curso cadastrado"}
            description={hasFilters ? "Ajuste os filtros para ver outros resultados." : "Cadastre os cursos que serão usados em leads e vendas."}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Curso</Th>
                <Th>Status</Th>
                <Th className="text-right">Custo da bolsa</Th>
                <Th>Custo atualizado em</Th>
                <Th>
                  <span className="sr-only">Ações</span>
                </Th>
              </tr>
            </thead>
            <Tbody>
              {list.map((course) => (
                <tr key={course.id} className={course.active ? undefined : "bg-slate-50/60"}>
                  <Td className={course.active ? "font-medium text-slate-900" : "font-medium text-slate-400"}>{course.name}</Td>
                  <Td>{course.active ? <Badge tone="success">Ativo</Badge> : <Badge>Inativo</Badge>}</Td>
                  <Td className="text-right tabular-nums">{formatBRL(course.scholarshipCostCents)}</Td>
                  <Td className="tabular-nums text-slate-500">{formatDateTime(course.costUpdatedAt)}</Td>
                  <Td>
                    <div className="flex items-center justify-end gap-1">
                      <EditCourseDialog course={course} />
                      <ActionButton
                        action={setCourseActiveAction}
                        fields={{ courseId: course.id, active: String(!course.active) }}
                        variant={course.active ? "ghost" : "secondary"}
                        confirm={course.active ? `Desativar "${course.name}"? Ele deixará de aparecer nos cadastros de leads e vendas.` : undefined}
                      >
                        {course.active ? "Desativar" : "Reativar"}
                      </ActionButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
