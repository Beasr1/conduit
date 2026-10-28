import {
  createBrowserRouter,
  Outlet,
  redirect,
  type RouteObject,
} from "react-router";

import { RouteError } from "@/components/route-error";

// Paths are built here, never written out in components.
export const routes = {
  signIn: (from?: string) =>
    from ? `/sign-in?${new URLSearchParams({ from })}` : "/sign-in",
  workflows: () => "/workflows",
  workflow: (id: string) => `/workflows/${encodeURIComponent(id)}`,
};

// safeFrom is where to go after signing in: a path on this site, or the
// workflow list. "//evil.example" and "/\evil.example" would leave the site.
export function safeFrom(from: string | null): string {
  if (!from || !from.startsWith("/") || /^\/[/\\]/.test(from))
    return routes.workflows();
  return from;
}

// Pages load lazily, so a page's code (later, the editor's React Flow) is
// fetched when it's first visited. It also means this file never imports a
// page, so pages can import routes from here.
//
// What shows before a page's code is in, or when it can't load, can't come
// from that code, so it's set here: the root's fallback and error boundary,
// and the boundary around the pages under the layout, which keeps the header
// (and Sign out) when a page fails.
export const appRoutes: RouteObject[] = [
  {
    // What a route with no Component renders anyway. Saying so keeps React
    // Router from warning when the root is all that matched, as on a 404.
    Component: Outlet,
    // Blank until the first page's code is in, as the page was while the
    // app's own code loaded; a spinner would only flash.
    HydrateFallback: () => null,
    ErrorBoundary: () => (
      <main>
        <RouteError home={routes.workflows()} />
      </main>
    ),
    children: [
      {
        index: true,
        loader: () => redirect(routes.workflows()),
        // Never shown, as the loader redirects first. Without it React
        // Router warns that the route renders nothing.
        Component: () => null,
      },
      { path: "sign-in", lazy: () => import("@/routes/sign-in") },
      {
        lazy: () => import("@/routes/layout"),
        children: [
          {
            ErrorBoundary: () => <RouteError home={routes.workflows()} />,
            children: [
              { path: "workflows", lazy: () => import("@/routes/workflows") },
              {
                path: "workflows/:id",
                lazy: () => import("@/routes/workflow"),
              },
            ],
          },
        ],
      },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(appRoutes);
}
