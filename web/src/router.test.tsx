import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import type { components } from "@/gen/schema";
import { appRoutes, routes, safeFrom, sessionEnded } from "@/router";
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

// A navigation's state can be anything a page put there.
test.each([
  [{ sessionEnded: true }, true],
  [{ sessionEnded: false }, false],
  [{ sessionEnded: "yes" }, false],
  [{}, false],
  [null, false],
  [undefined, false],
  ["sessionEnded", false],
])("a navigation with state %j is a session ended: %s", (state, ended) => {
  expect(sessionEnded(state)).toBe(ended);
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

test("a 401 goes to sign-in, carrying where you were", async () => {
  serverUp();
  server.use(
    http.get("/api/v1/workflows/wf-1", () =>
      HttpResponse.json<components["schemas"]["Problem"]>(
        { status: 401, code: "unauthorized", detail: "Sign in." },
        {
          status: 401,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
  );
  const { router } = renderRoutes(appRoutes, routes.workflow("wf-1"));
  expect(await screen.findByText("Sign in to Conduit")).toBeTruthy();
  expect(router.state.location.search).toBe("?from=%2Fworkflows%2Fwf-1");
});

test("Sign out ends the session, then goes to sign-in", async () => {
  serverUp();
  let ended = 0;
  server.use(
    http.delete("/api/v1/session", () => {
      ended++;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { router } = renderRoutes(appRoutes, routes.workflows());
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(routes.signIn()),
  );
  expect(ended).toBe(1);
});

// A sign-out the server didn't make leaves the session live, so the app
// stays where it is and says why.
test("a sign-out that fails stays", async () => {
  serverUp();
  server.use(
    http.delete("/api/v1/session", () =>
      HttpResponse.json<components["schemas"]["Problem"]>(
        {
          status: 500,
          code: "internal_error",
          detail: "Something went wrong on our side.",
        },
        {
          status: 500,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
  );
  const { router } = renderRoutes(appRoutes, routes.workflows());
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(await screen.findByText("Request failed")).toBeTruthy();
  expect(router.state.location.pathname).toBe(routes.workflows());
});
