"use client";

import { Pencil, Plus } from "lucide-react";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Field, Input } from "@/components/ui/form";
import { centsToInput } from "@/lib/money";
import { createCourseAction, updateCourseAction } from "./actions";

function CourseFields({
  errors,
  idPrefix,
  name,
  costCents,
}: {
  errors: Record<string, string[]>;
  idPrefix: string;
  name?: string;
  costCents?: number;
}) {
  return (
    <>
      <Field label="Nome do curso" htmlFor={`${idPrefix}-name`} errors={errors.name}>
        <Input id={`${idPrefix}-name`} name="name" defaultValue={name} required maxLength={150} />
      </Field>
      <Field
        label="Custo da bolsa (R$)"
        htmlFor={`${idPrefix}-cost`}
        errors={errors.scholarshipCostCents}
        hint="Visível somente para administradores."
      >
        <Input
          id={`${idPrefix}-cost`}
          name="scholarshipCost"
          inputMode="decimal"
          placeholder="0,00"
          defaultValue={costCents !== undefined ? centsToInput(costCents) : undefined}
          required
        />
      </Field>
    </>
  );
}

export function CreateCourseDialog() {
  return (
    <ActionDialog trigger={{ label: "Novo curso", icon: Plus }} title="Novo curso" action={createCourseAction} submitLabel="Criar curso">
      {(errors) => <CourseFields errors={errors} idPrefix="new-course" />}
    </ActionDialog>
  );
}

export function EditCourseDialog({ course }: { course: { id: string; name: string; scholarshipCostCents: number } }) {
  return (
    <ActionDialog
      trigger={{ label: "Editar", icon: Pencil, variant: "ghost", size: "sm" }}
      title="Editar curso"
      description="A alteração de custo fica registrada na auditoria."
      action={updateCourseAction}
    >
      {(errors) => (
        <>
          <input type="hidden" name="courseId" value={course.id} />
          <CourseFields errors={errors} idPrefix={`course-${course.id}`} name={course.name} costCents={course.scholarshipCostCents} />
        </>
      )}
    </ActionDialog>
  );
}
