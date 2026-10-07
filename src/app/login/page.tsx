import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BarChart3, GraduationCap, ShieldCheck, Users } from "lucide-react";
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
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-brand-700/60" aria-hidden />
        <div className="absolute -bottom-32 -left-16 size-80 rounded-full bg-brand-900/70" aria-hidden />
        <div className="relative flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/20">
            <GraduationCap className="size-6" aria-hidden />
          </span>
          <span className="text-lg font-semibold">CRM Polo Educacional</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-3xl font-semibold leading-tight">Disciplina comercial do primeiro contato à matrícula.</h1>
          <ul className="mt-8 space-y-4">
            {highlights.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-brand-100">
                <Icon className="size-5 text-white" aria-hidden />
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
            <span className="flex size-10 items-center justify-center rounded-xl bg-brand-800 text-white">
              <GraduationCap className="size-6" aria-hidden />
            </span>
            <span className="text-lg font-semibold text-brand-800">CRM Polo Educacional</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Entrar</h2>
          <p className="mt-1 text-sm text-slate-500">Use o e-mail e a senha fornecidos pelo administrador.</p>
          <LoginForm next={typeof next === "string" ? next : ""} />
        </div>
      </section>
    </main>
  );
}
