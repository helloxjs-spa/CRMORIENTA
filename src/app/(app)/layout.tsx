import { AppShell } from "@/components/layout/app-shell";
import { navigationFor } from "@/components/layout/navigation";
import { UserMenu } from "@/components/layout/user-menu";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS } from "@/lib/format";
import { requireActor } from "@/server/next/session";
import { logoutAction } from "../login/actions";

export default async function AuthenticatedLayout({ children }: LayoutProps<"/">) {
  const actor = await requireActor();

  return (
    <AppShell
      navigation={navigationFor(actor)}
      header={
        <>
          <Badge tone="brand" className="hidden sm:inline-flex">
            {ROLE_LABELS[actor.role]}
          </Badge>
          <UserMenu name={actor.name} email={actor.email} roleLabel={ROLE_LABELS[actor.role]} logoutAction={logoutAction} />
        </>
      }
    >
      {children}
    </AppShell>
  );
}
