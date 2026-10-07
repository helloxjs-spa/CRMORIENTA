import { SearchX } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <EmptyState
        icon={SearchX}
        title="Página não encontrada"
        description="O endereço não existe ou você não tem acesso a este registro."
        action={<ButtonLink href="/">Voltar ao início</ButtonLink>}
      />
    </main>
  );
}
