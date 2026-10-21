import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { OrientaLogo, OrientaMark } from "@/components/brand/orienta";
import { getCurrentActor } from "@/server/next/session";
import { LOGIN_AREAS, type LoginArea } from "./area";

export const metadata: Metadata = { title: "Entrar" };

/** Escolha da área, em tela cheia; o login de cada área usa a tela dividida de (split)/layout.tsx. */
export default async function LoginAreaPage({ searchParams }: PageProps<"/login">) {
  if (await getCurrentActor()) redirect("/");
  const { next } = await searchParams;
  // O ?next= vem das páginas protegidas do Varejo (proxy e requireActor); só faz sentido no login dele.
  const varejoHref = typeof next === "string" && next ? `${LOGIN_AREAS.varejo.href}?next=${encodeURIComponent(next)}` : LOGIN_AREAS.varejo.href;

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-brand-800 px-4 py-16 text-white">
      <OrientaMark className="pointer-events-none absolute -right-56 top-1/2 size-[42rem] -translate-y-1/2 opacity-[0.06]" />

      <div className="relative w-full max-w-xl text-center">
        <h1 className="sr-only">Entrar</h1>
        <OrientaLogo className="mx-auto max-w-xs sm:max-w-sm" priority />
        <p className="mt-12 text-brand-100">Escolha a área que você vai acessar. Cada área tem o seu próprio login.</p>

        <nav aria-label="Áreas de acesso" className="mt-8 grid gap-4 sm:grid-cols-2 sm:gap-6">
          {(Object.keys(LOGIN_AREAS) as LoginArea[]).map((area) => {
            const { label, icon: Icon, href } = LOGIN_AREAS[area];
            return (
              <Link
                key={area}
                href={area === "varejo" ? varejoHref : href}
                className="group flex flex-col items-center gap-4 rounded-2xl border border-gold-200/30 bg-white/5 px-6 py-8 text-gold-200 transition hover:border-gold-200 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold-200"
              >
                <span className="flex size-14 items-center justify-center rounded-full border border-gold-200/40 transition group-hover:bg-gold-200 group-hover:text-brand-800">
                  <Icon className="size-6" aria-hidden />
                </span>
                <span className="font-display text-xl font-semibold tracking-[0.12em]">{label.toUpperCase()}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <p className="absolute inset-x-0 bottom-6 text-center text-xs text-brand-200">Uso interno · acesso restrito a colaboradores</p>
    </main>
  );
}
