import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/server/next/session";
import { AreaHeading } from "../../area";
import { LoginForm } from "../../login-form";

export const metadata: Metadata = { title: "Entrar · Varejo" };

export default async function VarejoLoginPage({ searchParams }: PageProps<"/login/varejo">) {
  if (await getCurrentActor()) redirect("/");
  const { next } = await searchParams;

  return (
    <>
      <AreaHeading area="varejo" description="Use o e-mail e a senha do Varejo fornecidos pelo administrador." />
      <LoginForm next={typeof next === "string" ? next : ""} />
    </>
  );
}
