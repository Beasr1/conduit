import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { Component as WorkflowPage } from "@/routes/workflow";
import { specExample, workflowRevision } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type Preview = components["schemas"]["Preview"];
type Problem = components["schemas"]["Problem"];
type ProblemError = components["schemas"]["ProblemError"];
type Revision = components["schemas"]["Revision"];
type Validation = components["schemas"]["Validation"];
type Workflow = components["schemas"]["Workflow"];
type WorkflowRevision = components["schemas"]["WorkflowRevision"];

shimReactFlow();

// serveWorkflow answers for one workflow the way the server does: each save
// must name the latest revision in If-Match and becomes the next one, and a
// revision is published by number. It keeps what was sent, for the test to
// look at, and can save a revision elsewhere, as another tab would.
function serveWorkflow(
  definition: Definition = specExample,
  problems: ProblemError[] = [],
) {
  const start = workflowRevision("wf-1", "Send to CRM", definition);
  let workflow: Workflow = start.workflow;
  let latest: Revision = { ...start.revision, problems };
  const saves: { ifMatch: string | null; body: Definition }[] = [];
  const published: number[] = [];
  const save = (body: Definition) => {
    latest = {
      ...latest,
      revision: latest.revision + 1,
      definition: body,
      problems: [],
    };
    workflow = { ...workflow, latest_revision: latest.revision };
    return latest;
  };
  server.use(
    http.get("/api/v1/workflows/wf-1", () =>
      HttpResponse.json<WorkflowRevision>({ workflow, revision: latest }),
    ),
    http.post("/api/v1/validate", () =>
      HttpResponse.json<Validation>({ problems: [] }),
    ),
    // A step's fields offer the constants (plan 06): none here.
    http.get("/api/v1/constants", () => HttpResponse.json({ constants: [] })),
    // A step's Preview tab asks as soon as the step is picked.
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: null, nodes: {} },
        skipped: false,
        problems: [],
      }),
    ),
    http.put<PathParams, Definition, Problem | Revision>(
      "/api/v1/workflows/wf-1/draft",
      async ({ request }) => {
        const ifMatch = request.headers.get("If-Match");
        const body = await request.json();
        saves.push({ ifMatch, body });
        if (ifMatch !== `"${latest.revision}"`)
          return HttpResponse.json<Problem>(
            {
              code: "revision_mismatch",
              detail: "A newer revision was saved first.",
            },
            { status: 412 },
          );
        return HttpResponse.json<Revision>(save(body));
      },
    ),
    http.post<PathParams, { revision: number }, Workflow>(
      "/api/v1/workflows/wf-1/publish",
      async ({ request }) => {
        const { revision } = await request.json();
        published.push(revision);
        workflow = { ...workflow, published_revision: revision };
        return HttpResponse.json<Workflow>(workflow);
      },
    ),
    http.post("/api/v1/workflows/wf-1/archive", () => {
      workflow = {
        ...workflow,
        archived_at: "2026-11-06T09:00:00Z",
        archived_by: { actor: "token" },
      };
      return HttpResponse.json<Workflow>(workflow);
    }),
    http.post("/api/v1/workflows/wf-1/restore", () => {
      const { archived_at, archived_by, ...kept } = workflow;
      void [archived_at, archived_by];
      workflow = kept;
      return HttpResponse.json<Workflow>(workflow);
    }),
    http.get("/api/v1/workflows/wf-1/keys", () =>
      HttpResponse.json({ keys: [] }),
    ),
  );
  return { saves, published, saveElsewhere: save };
}

function open(routes: string[] = []) {
  return renderAt(<WorkflowPage />, {
    path: "/workflows/:id",
    at: "/workflows/wf-1",
    routes,
  });
}

async function pick(id: string) {
  fireEvent.click(await screen.findByText(id));
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: label }), {
    target: { value },
  });
}

// crm's URL in a draft.
const crmURL = (d: Definition) =>
  d.nodes.find((n) => n.id === "crm")?.request?.url;

test("opens a workflow on its canvas, every node and edge drawn", async () => {
  serveWorkflow();
  open();
  expect(
    await screen.findByRole("heading", { name: "Send to CRM" }),
  ).toBeTruthy();
  for (const id of ["user", "orders", "prefs", "crm"])
    expect(await screen.findByText(id)).toBeTruthy();
  expect(
    screen.getByText("POST https://crm.example.com/v1/contacts"),
  ).toBeTruthy();
  // Edges are drawn once React Flow has measured the nodes.
  await waitFor(() =>
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(4),
  );
});

test("a save names the revision it builds on, and the editor stays as it was", async () => {
  const server = serveWorkflow();
  open();
  await pick("crm");
  await screen.findByRole("textbox", { name: "URL" });
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
    "disabled",
    true,
  );

  type("URL", "https://crm.example.com/v2/contacts");
  expect(await screen.findByText("Revision 1 · Unsaved changes")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Revision 2 · Saved")).toBeTruthy();
  expect(server.saves.map((s) => s.ifMatch)).toEqual(['"1"']);
  expect(crmURL(server.saves[0]!.body)).toBe(
    "https://crm.example.com/v2/contacts",
  );
  // Still on crm, with what was typed.
  const panel = screen.getByRole("complementary", { name: "HTTP step" });
  expect(within(panel).getByRole("textbox", { name: "URL" })).toHaveProperty(
    "value",
    "https://crm.example.com/v2/contacts",
  );

  type("URL", "https://crm.example.com/v3/contacts");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Revision 3 · Saved")).toBeTruthy();
  expect(server.saves.map((s) => s.ifMatch)).toEqual(['"1"', '"2"']);
});

test("Ctrl-S saves, wherever the focus is", async () => {
  const server = serveWorkflow();
  open();
  await pick("crm");
  await screen.findByRole("textbox", { name: "URL" });
  type("URL", "https://crm.example.com/v2/contacts");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "URL" }), {
    key: "s",
    ctrlKey: true,
  });
  expect(await screen.findByText("Revision 2 · Saved")).toBeTruthy();
  expect(server.saves).toHaveLength(1);
});

// The id applies when the field is left, so Ctrl-S applies it first.
test("Ctrl-S in the Id field saves the id typed there", async () => {
  const server = serveWorkflow();
  open();
  await pick("crm");
  const id = await screen.findByLabelText("Id");
  type("Id", "contacts");
  fireEvent.keyDown(id, { key: "s", ctrlKey: true });
  expect(await screen.findByText("Revision 2 · Saved")).toBeTruthy();
  expect(server.saves[0]?.body.nodes.map((n) => n.id)).toEqual([
    "user",
    "orders",
    "prefs",
    "contacts",
  ]);
});

// Nothing is saved over a revision saved elsewhere: the draft stays on
// screen, to copy from, but Save and Publish are off until it's loaded.
test("after a newer revision is saved elsewhere, nothing is saved over it", async () => {
  const server = serveWorkflow();
  open();
  await pick("crm");
  await screen.findByRole("textbox", { name: "URL" });
  server.saveElsewhere(specExample);

  type("URL", "https://crm.example.com/v2/contacts");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const dialog = await screen.findByRole("dialog", {
    name: "A newer revision was saved",
  });
  expect(
    within(dialog).queryByRole("button", { name: "Save anyway" }),
  ).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  expect(
    await screen.findByText(
      "Revision 1 · Unsaved changes · Revision 2 was saved elsewhere",
    ),
  ).toBeTruthy();
  for (const name of ["Save", "Publish"])
    expect(screen.getByRole("button", { name })).toHaveProperty(
      "disabled",
      true,
    );
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  expect(screen.getByRole("textbox", { name: "URL" })).toHaveProperty(
    "value",
    "https://crm.example.com/v2/contacts",
  );
  expect(server.saves.map((s) => s.ifMatch)).toEqual(['"1"']);
});

// The workflow is fetched again when the tab comes back into view, so a
// revision saved in another tab is known before a save is tried.
test("a newer revision found when the tab is back in view stops a save before it's sent", async () => {
  const server = serveWorkflow();
  open();
  await pick("crm");
  await screen.findByRole("textbox", { name: "URL" });
  type("URL", "https://crm.example.com/v2/contacts");
  server.saveElsewhere(specExample);

  fireEvent(window, new Event("visibilitychange"));
  expect(
    await screen.findByText(
      "Revision 1 · Unsaved changes · Revision 2 was saved elsewhere",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load newer revision" }));
  expect(await screen.findByText("Revision 2")).toBeTruthy();
  expect(server.saves).toEqual([]);
});

test("after a newer revision is saved elsewhere, Load opens it afresh", async () => {
  const server = serveWorkflow();
  open();
  await pick("crm");
  await screen.findByRole("textbox", { name: "URL" });
  server.saveElsewhere({
    ...specExample,
    nodes: specExample.nodes.map((n) =>
      n.id === "crm"
        ? {
            ...n,
            request: { method: "POST", url: "https://crm.example.com/v9" },
          }
        : n,
    ),
  });

  type("URL", "https://crm.example.com/v2/contacts");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "A newer revision was saved" }),
    ).getByRole("button", { name: "Load newer revision" }),
  );
  expect(
    await screen.findByText("POST https://crm.example.com/v9"),
  ).toBeTruthy();
  expect(screen.getByText("Revision 2")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Publish saves what's on screen, publishes it, and says where it's served", async () => {
  const server = serveWorkflow();
  open();
  expect(
    await screen.findByText(/^Not published\. Publishing serves it at/),
  ).toBeTruthy();
  await pick("crm");
  await screen.findByRole("textbox", { name: "URL" });

  type("URL", "https://crm.example.com/v2/contacts");
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(await screen.findByText(/^Revision 2 is served at/)).toBeTruthy();
  expect(
    screen.getByText(`${window.location.origin}/serve/send-to-crm`),
  ).toBeTruthy();
  expect(server.saves.map((s) => s.ifMatch)).toEqual(['"1"']);
  expect(server.published).toEqual([2]);
  expect(screen.getByRole("button", { name: "Published" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("Publish with problems opens them, and sends nothing", async () => {
  const noURL: Definition = {
    ...specExample,
    nodes: specExample.nodes.map((n) =>
      n.id === "crm" ? { ...n, request: { method: "POST", url: "" } } : n,
    ),
  };
  const server = serveWorkflow(noURL, [
    {
      pointer: "/nodes/3/request/url",
      code: "required",
      detail: "a request needs a url",
    },
  ]);
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  expect(within(list).getByText("Add a URL.")).toBeTruthy();
  expect(server.saves).toEqual([]);
  expect(server.published).toEqual([]);
});

test("leaving with unsaved changes asks first", async () => {
  serveWorkflow();
  const { router } = open(["/workflows"]);
  await pick("crm");
  await screen.findByRole("textbox", { name: "URL" });
  type("URL", "https://crm.example.com/v2/contacts");
  await screen.findByText("Revision 1 · Unsaved changes");

  void router.navigate("/workflows");
  const dialog = await screen.findByRole("dialog", {
    name: "Leave without saving?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("heading", { name: "Send to CRM" })).toBeTruthy();

  void router.navigate("/workflows");
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "Leave without saving?" }),
    ).getByRole("button", { name: "Leave" }),
  );
  expect(await screen.findByText("at /workflows")).toBeTruthy();
});

// endSession makes the server refuse everything as it does once a session
// has ended, until a sign-in; then each request is answered as before. It
// keeps what each sign-in sent.
function endSession() {
  const signIns: unknown[] = [];
  server.use(
    http.post("/api/v1/session", async ({ request }) => {
      signIns.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }),
    http.all("/api/v1/*", () =>
      signIns.length > 0
        ? undefined
        : HttpResponse.json<Problem>(
            { status: 401, code: "unauthorized", detail: "Sign in." },
            {
              status: 401,
              headers: { "Content-Type": "application/problem+json" },
            },
          ),
    ),
  );
  return signIns;
}

test("a session that ends with unsaved changes signs in again where it is", async () => {
  const { saves } = serveWorkflow();
  const { router } = open(["/sign-in"]);
  await pick("crm");
  await screen.findByRole("textbox", { name: "URL" });
  const signIns = endSession();

  // The change's check is refused, which asks to sign in here, rather than
  // leaving for sign-in.
  type("URL", "https://crm.example.com/v2/contacts");
  const dialog = await screen.findByRole("dialog", { name: "Sign in again" });
  fireEvent.change(within(dialog).getByLabelText("API token"), {
    target: { value: "the-token" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(signIns).toEqual([{ token: "the-token" }]);
  expect(router.state.location.pathname).toBe("/workflows/wf-1");

  // The check is asked again, and the change is still there to save.
  await screen.findByText("Revision 1 · Unsaved changes");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Revision 2 · Saved");
  expect(saves.map((s) => crmURL(s.body))).toEqual([
    "https://crm.example.com/v2/contacts",
  ]);
});

test("a session that ends with unsaved changes can be left for sign-in", async () => {
  serveWorkflow();
  const { router } = open(["/sign-in"]);
  await pick("crm");
  await screen.findByRole("textbox", { name: "URL" });
  type("URL", "https://crm.example.com/v2/contacts");
  await screen.findByText("Revision 1 · Unsaved changes");

  // Going to sign-in on purpose, as Sign out does, only asks to leave.
  void router.navigate("/sign-in");
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "Leave without saving?" }),
    ).getByRole("button", { name: "Stay" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  endSession();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "Sign in again" }),
    ).getByRole("button", { name: "Leave without saving" }),
  );
  expect(await screen.findByText("at /sign-in")).toBeTruthy();
  expect(router.state.location.search).toBe("?from=%2Fworkflows%2Fwf-1");
});

// A step that uses a workflow (plan 07) opens drawn from the revision it
// pins, fetched with the workflow's name: its answers besides 2xx are its
// blocks.
test("a step that uses a workflow opens drawn from the revision it pins", async () => {
  serveWorkflow({
    nodes: [
      {
        id: "greet",
        kind: "http",
        uses: { workflow: "w-greeter", revision: 1 },
        with: { user_id: "input.id" },
        unhandled: { fail: true },
      },
    ],
  });
  const greeter: Definition = {
    nodes: [],
    response: {
      answers: [
        { status: 200, lines: [{ from: "user" }] },
        { status: 404, lines: [{ from: "user", on: 404 }] },
      ],
    },
  };
  const { workflow, revision } = workflowRevision(
    "w-greeter",
    "Greeter",
    greeter,
  );
  server.use(
    http.get("/api/v1/workflows/w-greeter", () =>
      HttpResponse.json<WorkflowRevision>({
        workflow: { ...workflow, published_revision: 1 },
        revision,
      }),
    ),
    http.get("/api/v1/workflows/w-greeter/revisions/1", () =>
      HttpResponse.json<Revision>(revision),
    ),
  );
  open();
  const card = await screen.findByTestId("rf__node-greet");
  expect(within(card).getByText("Greeter · r1")).toBeTruthy();
  expect(within(card).getByText("404")).toBeTruthy();
});

// The editor's own controls, by name, that change a workflow.
const changing = [
  "Save",
  "Run",
  "Publish",
  "Add HTTP step",
  "Add transform step",
];

// Archive asks again, and the workflow stays open, read-only, with Restore
// where Save, Run and Publish were: what's on its canvas opens to read, and
// nothing changes it. Restore brings it all back (plan 15).
test("Archive leaves it open, read-only, until Restore", async () => {
  serveWorkflow();
  open();
  fireEvent.click(
    await screen.findByRole("button", { name: "Archive Send to CRM" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Archive Send to CRM?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
  const restore = await screen.findByRole("button", { name: "Restore" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull(),
  );
  expect(screen.getByText(/^Revision 1 · Archived/)).toBeTruthy();
  expect(screen.getByText(/^Nothing is served at/)).toBeTruthy();
  for (const name of changing)
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Archive/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Tour" })).toBeNull();

  await pick("crm");
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  const url = await within(panel).findByRole("textbox", { name: "URL" });
  expect(url.matches(":disabled")).toBe(true);
  expect(
    within(panel).getByRole("textbox", { name: "Id" }).matches(":disabled"),
  ).toBe(true);
  // Its tabs still open what's on them.
  fireEvent.click(within(panel).getByRole("tab", { name: "2xx" }));
  expect(within(panel).getByRole("tab", { name: "2xx" }).ariaSelected).toBe(
    "true",
  );
  for (const name of ["Workflow settings", "Runs", "Keys"])
    expect(screen.getByRole("button", { name })).toBeTruthy();

  // Every panel reads the same way: the workflow's settings, a connection
  // and the response.
  fireEvent.click(screen.getByRole("button", { name: "Workflow settings" }));
  const settings = await screen.findByRole("complementary", {
    name: "Workflow settings",
  });
  expect(
    within(settings)
      .getByRole("textbox", { name: "Input schema" })
      .matches(":disabled"),
  ).toBe(true);
  fireEvent.click(await screen.findByTestId("rf__edge-user->orders"));
  const connection = await screen.findByRole("complementary", {
    name: "Connection",
  });
  expect(
    (
      await within(connection).findByRole("textbox", { name: "Condition" })
    ).matches(":disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByTestId("rf__node-#response"));
  const response = await screen.findByRole("complementary", {
    name: "Response",
  });
  expect(
    (await within(response).findByLabelText("Add an answer")).matches(
      ":disabled",
    ),
  ).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Keys" }));
  const keys = await screen.findByRole("complementary", {
    name: "Caller keys",
  });
  expect(
    await within(keys).findByText(
      "No key works: they went when it was archived.",
    ),
  ).toBeTruthy();
  expect(within(keys).queryByRole("button", { name: /New key/ })).toBeNull();

  fireEvent.click(restore);
  expect(await screen.findByRole("button", { name: "Publish" })).toBeTruthy();
  for (const name of changing)
    expect(screen.getByRole("button", { name })).toBeTruthy();
  expect(screen.queryByText(/Archived/)).toBeNull();
  expect(screen.getByText(/^Not published/)).toBeTruthy();
  expect(
    await within(keys).findByText(
      "No key works yet. Make one for each caller.",
    ),
  ).toBeTruthy();
});

// A workflow something live uses isn't archived: the dialog says what does,
// and the editor goes on as it was.
test("Archive says what uses it when the server refuses", async () => {
  serveWorkflow();
  const detail = "It's in use, so it can't be archived: Orders at revision 4.";
  server.use(
    http.post("/api/v1/workflows/wf-1/archive", () =>
      HttpResponse.json(
        { status: 409, code: "in_use", detail },
        {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
  );
  open();
  fireEvent.click(
    await screen.findByRole("button", { name: "Archive Send to CRM" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Archive Send to CRM?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
  expect(await within(dialog).findByText(detail)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Restore", hidden: true }),
  ).toBeNull();
});

// What's unsaved would be stranded by an archive, so it waits.
test("Archive waits for what's unsaved", async () => {
  serveWorkflow();
  open();
  await pick("crm");
  await screen.findByRole("textbox", { name: "URL" });
  const archive = screen.getByRole("button", { name: "Archive Send to CRM" });
  expect(archive.matches(":disabled")).toBe(false);
  type("URL", "https://crm.example.com/v2/contacts");
  await screen.findByText("Revision 1 · Unsaved changes");
  expect(archive.matches(":disabled")).toBe(true);
});

// A connection that isn't drawn has its Remove in the problem list, which
// stays open to read, without it, on an archived workflow.
test("an archived workflow's problems read, and offer nothing to change", async () => {
  const { saves } = serveWorkflow(
    { ...specExample, edges: [{ from: "gone", to: "crm" }] },
    [
      {
        pointer: "/edges/0/from",
        code: "unknown_node",
        detail: "no such step",
      },
    ],
  );
  server.use(
    http.get("/api/v1/workflows/wf-1", () => {
      const start = workflowRevision("wf-1", "Send to CRM", {
        ...specExample,
        edges: [{ from: "gone", to: "crm" }],
      });
      return HttpResponse.json<WorkflowRevision>({
        workflow: { ...start.workflow, archived_at: "2026-11-06T09:00:00Z" },
        revision: {
          ...start.revision,
          problems: [
            {
              pointer: "/edges/0/from",
              code: "unknown_node",
              detail: "no such step",
            },
          ],
        },
      });
    }),
  );
  open();
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const panel = await screen.findByRole("complementary", { name: "Problems" });
  expect(
    within(panel).getAllByText(/no such step|gone/i).length,
  ).toBeGreaterThan(0);
  expect(
    within(panel).queryByRole("button", { name: "Remove connection" }),
  ).toBeNull();
  expect(saves).toHaveLength(0);
});

// An open Keys panel is asked again once the workflow's archived, and shows
// its keys as the archive left them: revoked.
test("an open Keys panel shows the keys revoked by the archive", async () => {
  serveWorkflow();
  let revoked = false;
  const key = {
    id: "k1",
    name: "Billing",
    prefix: "cnd_k1",
    status: "active" as const,
    provenance: { actor: "token" },
    created_at: "2026-11-05T09:00:00Z",
  };
  server.use(
    http.get("/api/v1/workflows/wf-1/keys", () =>
      HttpResponse.json({
        keys: [
          revoked
            ? { ...key, status: "revoked", revoked_at: "2026-11-06T09:00:00Z" }
            : key,
        ],
      }),
    ),
    // Says it's revoked, then leaves the answer to serveWorkflow's.
    http.post("/api/v1/workflows/wf-1/archive", () => {
      revoked = true;
    }),
  );
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Keys" }));
  const keys = await screen.findByRole("complementary", {
    name: "Caller keys",
  });
  expect(
    await within(keys).findByRole("button", {
      name: "Revoke Billing (cnd_k1…)",
    }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Archive Send to CRM" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Archive Send to CRM?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
  expect(await within(keys).findByText(/revoked/)).toBeTruthy();
  expect(
    within(keys).queryByRole("button", { name: /Revoke Billing/ }),
  ).toBeNull();
});
