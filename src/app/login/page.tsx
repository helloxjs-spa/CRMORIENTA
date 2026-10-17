import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BarChart3, ShieldCheck, Users } from "lucide-react";
import { OrientaLogo, OrientaMark, OrientaWordmark } from "@/components/brand/orienta";
import { getCurrentActor } from "@/server/next/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

const highlights = [
  { icon: Users, text: "Equipes, vendedores e leads em um só lugar" },
  { icon: BarChart3, text: "Indicadores e ranking por vendedor e equipe" },
  { icon: ShieldCheck, text: "Acesso controlado por perfil e histórico completo" },
];

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getCurrentActor()) redirect("/");
  const { next } = await searchParams;

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-brand-800 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <OrientaMark className="absolute -bottom-40 -right-40 size-[34rem] opacity-[0.06]" />
        <OrientaLogo className="relative max-w-sm" priority />
        <div className="relative max-w-md">
          <p className="font-display text-sm font-semibold tracking-[0.2em] text-gold-200">CRM COMERCIAL</p>
          <h1 className="mt-3 text-3xl font-semibold leading-tight">Disciplina comercial do primeiro contato à matrícula.</h1>
          <ul className="mt-8 space-y-4">
            {highlights.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-brand-100">
                <Icon className="size-5 text-gold-200" aria-hidden />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-brand-200">Uso interno · acesso restrito a colaboradores</p>
      </section>

      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="flex size-12 items-center justify-center rounded-xl bg-brand-800 p-1">
              <OrientaMark className="size-full" />
            </span>
            <OrientaWordmark tone="dark" className="text-xl" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Entrar</h2>
          <p className="mt-1 text-sm text-slate-500">Use o e-mail e a senha fornecidos pelo administrador.</p>
          <LoginForm next={typeof next === "string" ? next : ""} />
        </div>
      </section>
    </main>
  );
}
