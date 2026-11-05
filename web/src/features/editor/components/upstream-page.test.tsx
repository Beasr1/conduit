import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import { UpstreamPage } from "@/features/editor/components/upstream-page";
import type { components } from "@/gen/schema";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type Upstream = components["schemas"]["Upstream"];
type UpstreamVersion = components["schemas"]["UpstreamVersion"];
type UpstreamUsers = components["schemas"]["UpstreamUsers"];
type Validation = components["schemas"]["Validation"];
type Preview = components["schemas"]["Preview"];

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

// answerPage has the server answer what the upstream's page asks: who uses
// it, its check, and previews.
function answerPage(problems: Validation["problems"] = []) {
  server.use(
    http.get("/api/v1/upstreams/u-1/users", () =>
      HttpResponse.json<UpstreamUsers>({
        workflows: [
          {
            workflow_id: "wf-1",
            name: "Orders",
            revision: 4,
            versions: [2],
            published: true,
          },
        ],
      }),
    ),
    http.post("/api/v1/upstreams/validate", () =>
      HttpResponse.json<Validation>({ problems }),
    ),
    // No constants, as the page offers each to its fields (plan 06).
    http.get("/api/v1/constants", () => HttpResponse.json({ constants: [] })),
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: null, nodes: {} },
        skipped: false,
        problems: [],
      }),
    ),
  );
}

// An upstream's page edits it on its own: its parameters with their
// samples, its request and responses in a step's tabs, checked as it's
// typed, and Save version makes the next.
test("an upstream's page edits it, and saves its next version", async () => {
  answerPage();
  let sent: { body: Upstream; ifMatch: string | null } | undefined;
  server.use(
    http.put<PathParams, Upstream, UpstreamVersion>(
      "/api/v1/upstreams/u-1",
      async ({ request }) => {
        sent = {
          body: await request.json(),
          ifMatch: request.headers.get("If-Match"),
        };
        return HttpResponse.json(version(sent.body, 3));
      },
    ),
  );
  renderAt(<UpstreamPage version={version(users, 2)} />, {
    path: "/upstreams/u-1",
    routes: ["/workflows/:id"],
  });
  expect(
    await screen.findByRole("heading", { name: "Users API" }),
  ).toBeTruthy();
  const usedBy = await screen.findByRole("region", { name: "Used by" });
  expect(within(usedBy).getByRole("link", { name: "Orders" })).toBeTruthy();
  expect(usedBy.textContent).toContain("v2 · served");
  // Each parameter is a name, under the column's, and their samples one
  // input object.
  const parameters = screen.getByRole("region", { name: "Parameters" });
  expect(within(parameters).getByText("Name")).toBeTruthy();
  const input = screen.getByLabelText("Sample input");
  expect(input).toHaveProperty("value", '{\n  "user_id": "7"\n}');

  const save = screen.getByRole("button", { name: "Save version 3" });
  expect(save.matches(":disabled")).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
    target: { value: "https://users.example.com/v2/users/{{ user_id }}" },
  });
  // A key that names no parameter is said, and not taken: the sample saved
  // is the one before.
  fireEvent.change(input, { target: { value: '{ "usr": "8" }' } });
  expect(
    await screen.findByText(
      "No parameter is named usr: the URL reads user_id.",
    ),
  ).toBeTruthy();
  await waitFor(() => expect(save.matches(":disabled")).toBe(false));
  fireEvent.click(save);
  await waitFor(() => expect(sent).toBeDefined());
  expect(sent?.ifMatch).toBe('"2"');
  expect(sent?.body).toEqual({
    ...users,
    request: {
      ...users.request,
      url: "https://users.example.com/v2/users/{{ user_id }}",
    },
  });
});

test("a problem the check finds shows under its field", async () => {
  answerPage([
    {
      pointer: "/request/url",
      code: "unknown_parameter",
      detail:
        "it reads usr_id, which isn't one of the upstream's parameters: add it, or fix the name",
    },
    {
      pointer: "/parameters/0/name",
      code: "invalid_name",
      detail: "not a name",
    },
  ]);
  renderAt(<UpstreamPage version={version(users, 2)} />, {
    path: "/upstreams/u-1",
  });
  expect(
    await screen.findByText(
      "It reads usr_id, which isn't one of the upstream's parameters: add it, or fix the name.",
    ),
  ).toBeTruthy();
  expect(await screen.findByText("not a name")).toBeTruthy();
});

// Its page is the one place an upstream is changed (plan 07), so a version
// saved there first, from another tab, is said rather than saved over.
test("Save version says when a newer version was saved elsewhere", async () => {
  answerPage();
  server.use(
    http.put("/api/v1/upstreams/u-1", () =>
      HttpResponse.json(
        { status: 412, code: "version_mismatch", detail: "moved on" },
        {
          status: 412,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
  );
  renderAt(<UpstreamPage version={version(users, 2)} />, {
    path: "/upstreams/u-1",
  });
  fireEvent.change(await screen.findByRole("textbox", { name: "URL" }), {
    target: { value: "https://users.example.com/v2/users/{{ user_id }}" },
  });
  const save = screen.getByRole("button", { name: "Save version 3" });
  await waitFor(() => expect(save.matches(":disabled")).toBe(false));
  fireEvent.click(save);
  expect(
    await screen.findByText(
      "A newer version was saved elsewhere. Reload the page to edit it.",
    ),
  ).toBeTruthy();
});

// Delete asks again, deletes the upstream with every version, and goes
// back to the library (plan 07).
test("Delete asks again, then deletes it and goes back to the library", async () => {
  answerPage();
  let deleted = false;
  server.use(
    http.delete("/api/v1/upstreams/u-1", () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  renderAt(<UpstreamPage version={version(users, 2)} />, {
    path: "/upstreams/u-1",
    routes: ["/upstreams"],
  });
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete Users API?",
  });
  expect(deleted).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  expect(await screen.findByText("at /upstreams")).toBeTruthy();
  expect(deleted).toBe(true);
});

// While a saved revision pins it, the server refuses, and the dialog says
// which revisions do.
test("Delete says which revisions pin it when the server refuses", async () => {
  answerPage();
  const detail =
    "Saved revisions pin it, and each must keep running: Orders at revision 4.";
  server.use(
    http.delete("/api/v1/upstreams/u-1", () =>
      HttpResponse.json(
        { status: 409, code: "upstream_in_use", detail },
        {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
  );
  renderAt(<UpstreamPage version={version(users, 2)} />, {
    path: "/upstreams/u-1",
    routes: ["/upstreams"],
  });
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete Users API?",
  });
  const confirm = within(dialog).getByRole("button", { name: "Delete" });
  fireEvent.click(confirm);
  expect(await within(dialog).findByText(detail)).toBeTruthy();
  expect(confirm.matches(":disabled")).toBe(true);
  expect(screen.queryByText("at /upstreams")).toBeNull();
});
