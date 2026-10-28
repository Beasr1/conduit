import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import type { components } from "@/gen/schema";
import { appRoutes, routes, safeFrom } from "@/router";
import { renderRoutes } from "@/test/render";
import { server } from "@/test/server";

// The workflow list's code doesn't load, as in a tab opened before a deploy.
// vi.mock is hoisted, so this holds for the whole file.
vi.mock("@/routes/workflows", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

test.each([
  ["/workflows/wf-1", "/workflows/wf-1"],
  ["/workflows?x=1", "/workflows?x=1"],
  [null, "/workflows"],
  ["", "/workflows"],
  ["https://evil.example", "/workflows"],
  ["//evil.example", "/workflows"],
  ["/\\evil.example", "/workflows"],
])("after signing in, from %j goes to %s", (from, to) => {
  expect(safeFrom(from)).toBe(to);
});

test("sign-in carries where you were", () => {
  expect(routes.signIn("/workflows/a b")).toBe(
    "/sign-in?from=%2Fworkflows%2Fa+b",
  );
});

// The layout's health badge asks the server how it is.
function serverUp() {
  server.use(
    http.get("/api/healthz", () =>
      HttpResponse.json<components["schemas"]["Health"]>({ status: "ok" }),
    ),
  );
}

test("/ goes to the workflow list", async () => {
  serverUp();
  const { router } = renderRoutes(appRoutes, "/");
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(routes.workflows()),
  );
});

test("an address with no page says so, with the way back", async () => {
  renderRoutes(appRoutes, "/no-such-page");
  expect(
    await screen.findByRole("heading", { name: "There's no page here" }),
  ).toBeTruthy();
  const back = screen.getByRole("link", { name: "Go to workflows" });
  expect(back.getAttribute("href")).toBe(routes.workflows());
});

test("a page that can't load says so under the header", async () => {
  serverUp();
  renderRoutes(appRoutes, routes.workflows());
  expect(
    await screen.findByRole("heading", { name: "Something went wrong" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
});
