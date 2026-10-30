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
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
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
  await screen.findByLabelText("URL");
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
  expect(within(panel).getByLabelText("URL")).toHaveProperty(
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
  await screen.findByLabelText("URL");
  type("URL", "https://crm.example.com/v2/contacts");
  fireEvent.keyDown(screen.getByLabelText("URL"), { key: "s", ctrlKey: true });
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
  await screen.findByLabelText("URL");
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
  expect(screen.getByLabelText("URL")).toHaveProperty(
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
  await screen.findByLabelText("URL");
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
  await screen.findByLabelText("URL");
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
  await screen.findByLabelText("URL");

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
  await screen.findByLabelText("URL");
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
