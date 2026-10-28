import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { Component as SignIn } from "@/routes/sign-in";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

function signIn(token: string) {
  fireEvent.change(screen.getByLabelText("API token"), {
    target: { value: token },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

test("signs in, then goes back where it was", async () => {
  let sent: unknown;
  server.use(
    http.post("/api/v1/session", async ({ request }) => {
      sent = await request.json();
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { router } = renderAt(<SignIn />, {
    path: "/sign-in",
    at: "/sign-in?from=%2Fworkflows%2Fwf-1",
    routes: ["/workflows/:id"],
  });

  signIn("the-token");
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/workflows/wf-1"),
  );
  expect(sent).toEqual({ token: "the-token" });
});

test("never leaves the site afterwards", async () => {
  server.use(
    http.post("/api/v1/session", () => new HttpResponse(null, { status: 204 })),
  );
  const { router } = renderAt(<SignIn />, {
    path: "/sign-in",
    at: "/sign-in?from=%2F%2Fevil.example",
    routes: ["/workflows"],
  });

  signIn("the-token");
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/workflows"),
  );
});

test("says when the token is wrong", async () => {
  server.use(
    http.post("/api/v1/session", () =>
      HttpResponse.json(
        {
          status: 401,
          code: "unauthorized",
          detail: "That isn't the API token.",
        },
        {
          status: 401,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
  );
  const { router } = renderAt(<SignIn />, { path: "/sign-in" });

  signIn("nope");
  expect(await screen.findByText("That isn't the API token.")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/sign-in");
});
