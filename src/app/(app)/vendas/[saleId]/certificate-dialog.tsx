"use client";

import { Award } from "lucide-react";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Field, Input } from "@/components/ui/form";
import { CERTIFIER_MAX_LENGTH } from "@/lib/certificates";
import { registerCertificateAction } from "../../certificados/actions";

/**
 * Registro do certificado de UM curso (item) da venda: conclusão, entrega e
 * certificadora, tudo de uma vez (C51). O serviço confere escopo, se o item
 * ainda pode receber certificado, as datas e a duplicidade.
 */
export function CertificateDialog({ saleItemId, courseName, today }: { saleItemId: string; courseName: string; today: string }) {
  const id = (field: string) => `cert-${field}-${saleItemId}`;
  return (
    <ActionDialog
      trigger={{ label: "Registrar certificado", icon: Award, variant: "secondary", size: "sm" }}
      title="Registrar certificado"
      description={`${courseName}. O aluno concluiu o curso e recebeu o certificado.`}
      action={registerCertificateAction}
      submitLabel="Registrar"
    >
      {(errors) => (
        <>
          <input type="hidden" name="saleItemId" value={saleItemId} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Data de conclusão" htmlFor={id("completed")} errors={errors.completedOn}>
              <Input id={id("completed")} name="completedOn" type="date" required max={today} aria-invalid={errors.completedOn?.length ? true : undefined} />
            </Field>
            <Field label="Data de entrega" htmlFor={id("delivered")} errors={errors.deliveredOn}>
              <Input id={id("delivered")} name="deliveredOn" type="date" required max={today} aria-invalid={errors.deliveredOn?.length ? true : undefined} />
            </Field>
          </div>
          <Field label="Certificadora" htmlFor={id("certifier")} errors={errors.certifier}>
            <Input
              id={id("certifier")}
              name="certifier"
              required
              maxLength={CERTIFIER_MAX_LENGTH}
              aria-invalid={errors.certifier?.length ? true : undefined}
            />
          </Field>
        </>
      )}
    </ActionDialog>
  );
}
