import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { HealthBadge } from "@/components/health-badge";

const server = setupServer();

// A request with no handler fails the test instead of reaching the network.
// (MSW 3 renamed this option from onUnhandledRequest.)
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function renderBadge() {
  // No retries, so a failing request shows its error straight away.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <HealthBadge />
    </QueryClientProvider>,
  );
}

test("shows the server as up when /api/healthz answers", async () => {
  server.use(
    http.get("/api/healthz", () => HttpResponse.json({ status: "ok" })),
  );
  renderBadge();

  const badge = await screen.findByText("server ok");
  expect(badge.className).toContain("badge-up");
});

test("shows the server as unreachable when /api/healthz fails", async () => {
  server.use(
    http.get("/api/healthz", () => new HttpResponse(null, { status: 503 })),
  );
  renderBadge();

  const badge = await screen.findByText("server unreachable");
  expect(badge.className).toContain("badge-down");
});
