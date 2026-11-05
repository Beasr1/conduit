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
      {/* One row; on a narrow screen the lists take a second, under the
          name and the session, so the header never runs wider than it. */}
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-6 py-3">
        <Link to={routes.workflows()} className="font-heading font-semibold">
          Conduit
        </Link>
        {/* The lists: what's built, the APIs it calls (plan 07), and the
            values they read (plan 06). */}
        <nav
          aria-label="Main"
          className="order-last flex w-full items-center gap-4 text-sm sm:order-none sm:w-auto sm:flex-1"
        >
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
          <NavLink
            to={routes.constants()}
            className="text-muted-foreground underline-offset-4 hover:underline aria-[current=page]:text-foreground"
          >
            Constants
          </NavLink>
        </nav>
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
