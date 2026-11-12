import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import { UpstreamPage } from "@/features/editor/components/upstream-page";
import type { components } from "@/gen/schema";
import { Component as Page } from "@/routes/upstream";
import { renderAt, renderRoutes } from "@/test/render";
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

// answerArchive has the server archive and restore it, as the page's query
// would then hold it.
function answerArchive() {
  let archived = false;
  const summary = () => ({
    ...version(users, 2).upstream,
    ...(archived ? { archived_at: at, archived_by: { actor: "token" } } : {}),
  });
  server.use(
    http.post("/api/v1/upstreams/u-1/archive", () => {
      archived = true;
      return HttpResponse.json(summary());
    }),
    http.post("/api/v1/upstreams/u-1/restore", () => {
      archived = false;
      return HttpResponse.json(summary());
    }),
    http.get("/api/v1/upstreams/u-1", () =>
      HttpResponse.json<UpstreamVersion>({
        ...version(users, 2),
        upstream: summary(),
      }),
    ),
  );
}

// Archive asks again, and the page stays, read-only, with Restore where Save
// was; Restore brings it all back (plan 15).
test("Archive asks again, and the page stays, read-only, until it's restored", async () => {
  answerPage();
  answerArchive();
  renderRoutes(
    [{ path: "/upstreams/:id", element: <Page /> }],
    "/upstreams/u-1",
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Archive Users API" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Archive Users API?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
  const restore = await screen.findByRole("button", { name: "Restore" });
  expect(screen.getByText(/· Archived/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Save version/ })).toBeNull();
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull(),
  );
  // Nothing changes it, and what's on its tabs can still be read.
  for (const name of ["Name of parameter user_id", "Add a parameter", "URL"])
    expect(screen.getByRole("textbox", { name }).matches(":disabled")).toBe(
      true,
    );
  fireEvent.click(screen.getByRole("tab", { name: "404" }));
  expect(screen.getByRole("tab", { name: "404" }).ariaSelected).toBe("true");
  // Used by is as Archive checks it, and stays.
  expect(
    within(screen.getByRole("region", { name: "Used by" })).getByRole("link", {
      name: "Orders",
    }),
  ).toBeTruthy();

  fireEvent.click(restore);
  expect(
    await screen.findByRole("button", { name: "Save version 3" }),
  ).toBeTruthy();
  expect(screen.queryByText(/Archived/)).toBeNull();
  expect(
    screen
      .getByRole("textbox", { name: "Name of parameter user_id" })
      .matches(":disabled"),
  ).toBe(false);
});

// While something live uses it, the server refuses, and the dialog says
// what does.
test("Archive says what uses it when the server refuses", async () => {
  answerPage();
  const detail = "It's in use, so it can't be archived: Orders at revision 4.";
  server.use(
    http.post("/api/v1/upstreams/u-1/archive", () =>
      HttpResponse.json(
        { status: 409, code: "in_use", detail },
        {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
  );
  renderAt(<UpstreamPage version={version(users, 2)} />, {
    path: "/upstreams/u-1",
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Archive Users API" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Archive Users API?",
  });
  const confirm = within(dialog).getByRole("button", { name: "Archive" });
  fireEvent.click(confirm);
  expect(await within(dialog).findByText(detail)).toBeTruthy();
  expect(confirm.matches(":disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
});

// What's unsaved would be stranded by an archive.
test("Archive waits for what's unsaved", async () => {
  answerPage();
  renderAt(<UpstreamPage version={version(users, 2)} />, {
    path: "/upstreams/u-1",
  });
  const archive = await screen.findByRole("button", {
    name: "Archive Users API",
  });
  expect(archive.matches(":disabled")).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
    target: { value: "https://users.example.com/v2/{{ user_id }}" },
  });
  expect(await screen.findByText(/Unsaved changes/)).toBeTruthy();
  expect(archive.matches(":disabled")).toBe(true);
});

// A workflow on two revisions, latest and served, shows on two lines.
test("Used by lists each revision that uses it", async () => {
  answerPage();
  server.use(
    http.get("/api/v1/upstreams/u-1/users", () =>
      HttpResponse.json<UpstreamUsers>({
        workflows: [
          {
            workflow_id: "wf-1",
            name: "Orders",
            revision: 3,
            versions: [1],
            published: true,
          },
          {
            workflow_id: "wf-1",
            name: "Orders",
            revision: 4,
            versions: [2],
            published: false,
          },
        ],
      }),
    ),
  );
  renderAt(<UpstreamPage version={version(users, 2)} />, {
    path: "/upstreams/u-1",
  });
  expect(await screen.findByText("· v1 · served")).toBeTruthy();
  expect(screen.getByText("· v2")).toBeTruthy();
});

// Nothing will use an archived one, so its Used by says so without "yet".
test("an archived upstream nothing uses says so plainly", async () => {
  answerPage();
  server.use(
    http.get("/api/v1/upstreams/u-1/users", () =>
      HttpResponse.json<UpstreamUsers>({ workflows: [] }),
    ),
  );
  const archived = version(users, 2);
  renderAt(
    <UpstreamPage
      version={{
        ...archived,
        upstream: {
          ...archived.upstream,
          archived_at: at,
          archived_by: { actor: "token" },
        },
      }}
    />,
    { path: "/upstreams/u-1" },
  );
  expect(await screen.findByText("No workflow uses it.")).toBeTruthy();
});
