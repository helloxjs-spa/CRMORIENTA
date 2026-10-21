import type { Metadata } from "next";
import { Info } from "lucide-react";
import { AreaHeading } from "../../area";

export const metadata: Metadata = { title: "Entrar · Expansão" };

/*
 * O CRM de Expansão ainda não foi integrado: quando for, este é o lugar do
 * formulário de login dele, com credenciais próprias (uma sessão do Varejo
 * não dá acesso à Expansão, e vice-versa).
 */
export default function ExpansaoLoginPage() {
  return (
    <>
      <AreaHeading area="expansao" description="Use o e-mail e a senha da Expansão fornecidos pelo administrador." />
      <div role="status" className="mt-8 flex gap-3 rounded-lg border border-brand-100 bg-brand-50 p-4 text-sm text-brand-800">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>O acesso à Expansão está em integração e será liberado em breve.</p>
      </div>
    </>
  );
}
