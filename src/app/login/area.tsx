import Link from "next/link";
import { ArrowLeft, Store, TrendingUp } from "lucide-react";

/*
 * O sistema tem duas áreas com logins independentes: o acesso a uma não
 * implica acesso à outra. A escolha acontece antes do formulário de login.
 */
export const LOGIN_AREAS = {
  varejo: { label: "Varejo", icon: Store, href: "/login/varejo" },
  expansao: { label: "Expansão", icon: TrendingUp, href: "/login/expansao" },
} as const;

export type LoginArea = keyof typeof LOGIN_AREAS;

/** Cabeçalho das telas de login de uma área, com volta para a escolha. */
export function AreaHeading({ area, description }: { area: LoginArea; description: string }) {
  const { label, icon: Icon } = LOGIN_AREAS[area];
  return (
    <>
      <Link href="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-brand-700">
        <ArrowLeft className="size-4" aria-hidden />
        Trocar área
      </Link>
      <p className="mt-6 flex items-center gap-2 font-display text-sm font-semibold tracking-[0.2em] text-gold-600">
        <Icon className="size-4" aria-hidden />
        {label.toUpperCase()}
      </p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Entrar no {label}</h2>
      <p className="mt-1 text-sm text-slate-500">{description}</p>
    </>
  );
}
