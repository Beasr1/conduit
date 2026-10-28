import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";

import { Toaster } from "@/components/ui/toast";
import { createQueryClient } from "@/lib/query-client";

// renderAt renders ui at path, with the app's providers: a query client
// that doesn't retry, toasts, and a router in memory. routes are the other
// pages a test can land on; each shows its own path.
export function renderAt(
  ui: ReactNode,
  {
    path = "/",
    at = path,
    routes = [],
  }: { path?: string; at?: string; routes?: string[] } = {},
) {
  const pages: RouteObject[] = routes.map((p) => ({
    path: p,
    element: <p>at {p}</p>,
  }));
  return renderRoutes([{ path, element: ui }, ...pages], at);
}

// renderRoutes renders a route tree, such as the app's own, at a path, with
// the same providers as renderAt.
export function renderRoutes(tree: RouteObject[], at: string) {
  const onUnauthorized = { called: false };
  const queryClient = createQueryClient(() => {
    onUnauthorized.called = true;
  });
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(tree, { initialEntries: [at] });
  render(
    <QueryClientProvider client={queryClient}>
      <Toaster>
        <RouterProvider router={router} />
      </Toaster>
    </QueryClientProvider>,
  );
  return { router, onUnauthorized };
}
