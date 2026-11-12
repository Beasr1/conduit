import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import { CreateUpstreamDialog } from "@/features/upstreams/components/create-upstream-dialog";
import { UpstreamList } from "@/features/upstreams/components/upstream-list";
import type { components } from "@/gen/schema";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type Upstream = components["schemas"]["Upstream"];
type UpstreamVersion = components["schemas"]["UpstreamVersion"];
type UpstreamList = components["schemas"]["UpstreamList"];
type CreateUpstream = components["schemas"]["CreateUpstream"];

const at = "2026-11-02T00:00:00Z";

const users: Upstream = {
  parameters: [{ name: "user_id", sample: "7" }],
  request: {
    method: "GET",
    url: "https://users.example.com/v1/users/{{ user_id }}",
  },
  outputs: [{ status: 404 }],
};

function version(definition: Upstream, n: number): UpstreamVersion {
  return {
    upstream: {
      id: "u-1",
      name: "Users API",
      latest_version: n,
      created_at: at,
    },
    version: n,
    definition,
    provenance: { actor: "token" },
    created_at: at,
  };
}

// The library lists its upstreams, each with its latest version, and says
// what to do first when there are none (plan 07).
test("the library lists its upstreams, or says how to start", async () => {
  server.use(
    http.get("/api/v1/upstreams", () =>
      HttpResponse.json<UpstreamList>({
        upstreams: [version(users, 2).upstream],
      }),
    ),
  );
  renderAt(<UpstreamList />, { path: "/upstreams" });
  const row = (await screen.findByRole("link", { name: "Users API" })).closest(
    "tr",
  );
  expect(row?.textContent).toContain("2");

  server.use(
    http.get("/api/v1/upstreams", () =>
      HttpResponse.json<UpstreamList>({ upstreams: [] }),
    ),
  );
});

test("an empty library says how to start", async () => {
  server.use(
    http.get("/api/v1/upstreams", () =>
      HttpResponse.json<UpstreamList>({ upstreams: [] }),
    ),
  );
  renderAt(<UpstreamList />, { path: "/upstreams" });
  expect(await screen.findByText(/No upstreams yet/)).toBeTruthy();
});

test("New upstream makes one from a name and its call, and opens it", async () => {
  let sent: CreateUpstream | undefined;
  server.use(
    http.post<PathParams, CreateUpstream, UpstreamVersion>(
      "/api/v1/upstreams",
      async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(version(sent.definition, 1), { status: 201 });
      },
    ),
  );
  const { router } = renderAt(<CreateUpstreamDialog />, {
    path: "/upstreams",
    routes: ["/upstreams/:id"],
  });
  fireEvent.click(screen.getByRole("button", { name: "New upstream" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Users API" },
  });
  fireEvent.change(screen.getByLabelText("URL"), {
    target: { value: "https://users.example.com/v1/users/{{ user_id }}" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Make" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/upstreams/u-1"),
  );
  expect(sent).toEqual({
    name: "Users API",
    definition: {
      parameters: [{ name: "user_id" }],
      request: {
        method: "GET",
        url: "https://users.example.com/v1/users/{{ user_id }}",
      },
    },
  });
});

test("New upstream says when the name is taken", async () => {
  server.use(
    http.post("/api/v1/upstreams", () =>
      HttpResponse.json(
        { status: 409, code: "conflict", detail: "taken" },
        {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
  );
  renderAt(<CreateUpstreamDialog />, { path: "/upstreams" });
  fireEvent.click(screen.getByRole("button", { name: "New upstream" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Users API" },
  });
  fireEvent.change(screen.getByLabelText("URL"), {
    target: { value: "https://users.example.com/v1/users" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Make" }));
  expect(
    await screen.findByText("An upstream already has that name."),
  ).toBeTruthy();
  expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe(
    "true",
  );
});

// New upstream takes its samples too: one input object for the parameters
// the URL reads, and a sample of each response the API can give.
test("New upstream makes one with its sample input and each response", async () => {
  let sent: CreateUpstream | undefined;
  server.use(
    http.post<PathParams, CreateUpstream, UpstreamVersion>(
      "/api/v1/upstreams",
      async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(version(sent.definition, 1), { status: 201 });
      },
    ),
  );
  renderAt(<CreateUpstreamDialog />, {
    path: "/upstreams",
    routes: ["/upstreams/:id"],
  });
  fireEvent.click(screen.getByRole("button", { name: "New upstream" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Users API" },
  });
  fireEvent.change(screen.getByLabelText("URL"), {
    target: { value: "https://users.example.com/v1/users/{{ user_id }}" },
  });
  const input = screen.getByLabelText("Sample input");
  fireEvent.change(input, { target: { value: '{ "usr": "7" }' } });
  fireEvent.click(screen.getByRole("button", { name: "Add a response" }));
  fireEvent.click(screen.getByRole("button", { name: "Make" }));
  // Checked when it's made: nothing is sent while a sample doesn't fit.
  expect(
    await screen.findByText(
      "No parameter is named usr: the URL reads user_id.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("A status: three digits.")).toBeTruthy();
  expect(sent).toBeUndefined();

  fireEvent.change(input, { target: { value: '{ "user_id": "7" }' } });
  fireEvent.change(screen.getByLabelText("Response 1 body"), {
    target: { value: '{ "id": "7", "name": "Ada" }' },
  });
  fireEvent.change(screen.getByLabelText("Response 2 status"), {
    target: { value: "404" },
  });
  fireEvent.change(screen.getByLabelText("Response 2 body"), {
    target: { value: '{ "error": "not found" }' },
  });
  fireEvent.click(screen.getByRole("button", { name: "Make" }));
  await waitFor(() => expect(sent).toBeDefined());
  expect(sent?.definition).toEqual({
    parameters: [{ name: "user_id", sample: "7" }],
    request: {
      method: "GET",
      url: "https://users.example.com/v1/users/{{ user_id }}",
    },
    sample: { body: { id: "7", name: "Ada" } },
    outputs: [{ status: 404, sample: { body: { error: "not found" } } }],
  });
});

// The archived ones are asked for, and say when (plan 15).
test("the library's Archived tab lists what's archived", async () => {
  const asked: (string | null)[] = [];
  server.use(
    http.get("/api/v1/upstreams", ({ request }) => {
      asked.push(new URL(request.url).searchParams.get("archived"));
      return HttpResponse.json<UpstreamList>({
        upstreams: [
          {
            ...version(users, 2).upstream,
            archived_at: "2026-11-06T09:00:00Z",
          },
        ],
      });
    }),
  );
  renderAt(<UpstreamList archived />, { path: "/upstreams" });
  expect(await screen.findByRole("link", { name: "Users API" })).toBeTruthy();
  expect(asked).toEqual(["true"]);
  expect(screen.getByRole("columnheader", { name: "Archived" })).toBeTruthy();
});

test("says when nothing in the library is archived", async () => {
  server.use(
    http.get("/api/v1/upstreams", () =>
      HttpResponse.json<UpstreamList>({ upstreams: [] }),
    ),
  );
  renderAt(<UpstreamList archived />, { path: "/upstreams" });
  expect(await screen.findByText(/Nothing archived/)).toBeTruthy();
});
