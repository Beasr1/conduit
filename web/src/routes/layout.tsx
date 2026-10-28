import { Link, Outlet } from "react-router";

import { HealthBadge } from "@/components/health-badge";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/features/session/hooks/use-session";
import { routes } from "@/router";

export function Component() {
  const signOut = useSignOut();
  return (
    // The window's height exactly, with main scrolling inside it, so a page
    // can fill what's left, as the editor's canvas does.
    <div className="flex h-svh flex-col">
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
      <main className="min-h-0 flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
