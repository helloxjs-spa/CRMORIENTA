"use client";

import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { courseLabel } from "@/lib/leads";
import { formatPhone, parseBrazilianPhone } from "@/lib/phone";
import { createLeadAction, editLeadAction } from "./actions";

export type CourseChoice = { id: string; name: string; institutionName: string; active: boolean };

/** Aceita qualquer formato; ao sair do campo, mostra o telefone já formatado. */
function PhoneField({ id, defaultValue, errors }: { id: string; defaultValue?: string; errors?: string[] }) {
  const [value, setValue] = useState(defaultValue ?? "");
  return (
    <Field label="Telefone" htmlFor={id} errors={errors} hint="Com DDD. Ex.: (79) 99999-9999 ou +55 79 99999-9999.">
      <Input
        id={id}
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="off"
        required
        maxLength={40}
        placeholder="(79) 99999-9999"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const parsed = parseBrazilianPhone(value);
          if (parsed.ok) setValue(formatPhone(parsed.phone));
        }}
        aria-invalid={errors?.length ? true : undefined}
      />
    </Field>
  );
}

function LeadFields({
  idPrefix,
  errors,
  courses,
  lead,
}: {
  idPrefix: string;
  errors: Record<string, string[]>;
  courses: CourseChoice[];
  lead?: { name: string; phone: string; interestCourseId: string };
}) {
  // Na edição, um curso inativado depois do cadastro continua disponível só
  // como o valor atual (mantê-lo não é uma mudança); outros inativos não aparecem.
  const options = courses.filter((c) => c.active || c.id === lead?.interestCourseId);
  return (
    <>
      <Field label="Nome completo" htmlFor={`${idPrefix}-name`} errors={errors.name}>
        <Input
          id={`${idPrefix}-name`}
          name="name"
          required
          maxLength={120}
          autoComplete="off"
          defaultValue={lead?.name}
          aria-invalid={errors.name?.length ? true : undefined}
        />
      </Field>
      <PhoneField id={`${idPrefix}-phone`} defaultValue={lead ? formatPhone(lead.phone) : undefined} errors={errors.phone} />
      <Field label="Curso de interesse" htmlFor={`${idPrefix}-course`} errors={errors.interestCourseId}>
        <Select id={`${idPrefix}-course`} name="interestCourseId" required defaultValue={lead?.interestCourseId ?? ""}>
          <option value="" disabled>
            Selecione o curso
          </option>
          {options.map((course) => (
            <option key={course.id} value={course.id}>
              {courseLabel(course)}
              {course.active ? "" : " (inativo, atual)"}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

export function NewLeadDialog({ courses }: { courses: CourseChoice[] }) {
  return (
    <ActionDialog
      trigger={{ label: "Novo Lead", icon: Plus }}
      title="Novo lead"
      description="O lead entra na sua carteira, na etapa Lead cadastrado."
      action={createLeadAction}
      submitLabel="Cadastrar lead"
    >
      {(errors) => <LeadFields idPrefix="new-lead" errors={errors} courses={courses} />}
    </ActionDialog>
  );
}

export function EditLeadDialog({
  lead,
  courses,
}: {
  lead: { id: string; name: string; phone: string; interestCourseId: string };
  courses: CourseChoice[];
}) {
  return (
    <ActionDialog
      trigger={{ label: "Editar", icon: Pencil, variant: "secondary", size: "sm" }}
      title="Editar lead"
      description="Responsável, equipe, etapa e prazos têm operações próprias e não mudam aqui."
      action={editLeadAction}
    >
      {(errors) => (
        <>
          <input type="hidden" name="leadId" value={lead.id} />
          <LeadFields idPrefix={`edit-${lead.id}`} errors={errors} courses={courses} lead={lead} />
        </>
      )}
    </ActionDialog>
  );
}
