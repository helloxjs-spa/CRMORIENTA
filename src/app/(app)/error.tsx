"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <EmptyState
        icon={TriangleAlert}
        title="Não foi possível carregar esta página"
        description="Ocorreu um erro inesperado. Tente novamente; se persistir, avise o administrador."
        action={<Button onClick={reset}>Tentar novamente</Button>}
      />
    </Card>
  );
}
