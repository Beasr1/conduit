import { Link, NavLink, Outlet } from "react-router";

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
        <div className="flex items-center gap-6">
          <Link to={routes.workflows()} className="font-heading font-semibold">
            Conduit
          </Link>
          {/* The two lists: what's built, and the APIs it calls (plan 07). */}
          <nav aria-label="Main" className="flex items-center gap-4 text-sm">
            <NavLink
              to={routes.workflows()}
              className="text-muted-foreground underline-offset-4 hover:underline aria-[current=page]:text-foreground"
            >
              Workflows
            </NavLink>
            <NavLink
              to={routes.upstreams()}
              className="text-muted-foreground underline-offset-4 hover:underline aria-[current=page]:text-foreground"
            >
              Upstreams
            </NavLink>
          </nav>
        </div>
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
