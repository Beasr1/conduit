import { Link, Outlet } from "react-router";

import { HealthBadge } from "@/components/health-badge";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/features/session/hooks/use-session";
import { routes } from "@/router";

export function Component() {
  const signOut = useSignOut();
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-3">
        <Link to={routes.workflows()} className="font-heading font-semibold">
          Conduit
        </Link>
        <div className="flex items-center gap-3">
          <HealthBadge />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            Sign out
          </Button>
        </div>
      </header>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
