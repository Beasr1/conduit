import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { workflowRevision } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type Preview = components["schemas"]["Preview"];
type Revision = components["schemas"]["Revision"];
type Run = components["schemas"]["Run"];

shimReactFlow();

// respond gives one value, and picks between 200 and 400.
const respond: Definition = {
  nodes: [{ id: "respond", kind: "transform", expr: "{ 'id': 1 }" }],
  response: {
    answers: [
      { status: 200, from: "respond" },
      { status: 400, from: "respond" },
    ],
  },
};

// cased has two cases: found answers 200, and missing goes on to fallback;
// with neither holding, Unhandled answers 500.
const cased: Definition = {
  nodes: [
    {
      id: "respond",
      kind: "transform",
      switch: {
        cases: [
          {
            name: "found",
            when: "input.id != 0",
            status: 200,
            body: "{ 'id': input.id }",
          },
          { name: "missing", when: "input.id = 0", status: 404 },
        ],
      },
    },
    { id: "fallback", kind: "transform", expr: "1" },
  ],
  edges: [{ from: "respond", to: "fallback", on: 404 }],
  response: {
    answers: [
      { status: 200, from: "respond", on: 200 },
      { status: 500, from: "respond", unhandled: true },
    ],
  },
};

const field = (name: string) => screen.getByRole("textbox", { name });

function type(name: string, value: string) {
  fireEvent.change(field(name), { target: { value } });
}

async function open() {
  fireEvent.click(await screen.findByText("respond"));
  return screen.findByRole("complementary", { name: "Transform step" });
}

function tab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

// blocks is what the step's card says on its right: each exit, then + Case.
const blocks = () =>
  [
    ...screen
      .getByTestId("rf__node-respond")
      .querySelectorAll("[data-part]:not([data-part=unhandled])"),
  ].map((b) => `${b.getAttribute("data-part")} ${b.textContent}`);

// saving has the server keep what Save sends; save clicks it and gives that.
function saving() {
  const saved: Definition[] = [];
  server.use(
    http.put<PathParams, Definition, Revision>(
      "/api/v1/workflows/wf-1/draft",
      async ({ request }) => {
        const draft = await request.json();
        saved.push(draft);
        const { revision } = workflowRevision("wf-1", "Spec example", draft);
        return HttpResponse.json<Revision>({ ...revision, revision: 2 });
      },
    ),
  );
  return async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    return saved[0];
  };
}

test("a transform with cases has an exit for each, and a click on one opens its tab", async () => {
  renderEditor(cased);
  const card = await screen.findByTestId("rf__node-respond");
  expect(blocks()).toEqual([
    "case:0 found · 200",
    "case:1 missing · 404",
    "add + Case",
  ]);
  fireEvent.click(within(card).getByText("missing"));
  const panel = await screen.findByRole("complementary", {
    name: "Transform step",
  });
  expect(within(panel).getByRole("tab", { name: "missing" }).ariaSelected).toBe(
    "true",
  );
  expect(
    within(panel).getByRole("button", {
      name: "Connection to fallback always",
    }),
  ).toBeTruthy();
});

test("Use cases makes the expression the first case's, and each other answer a case's, their lines going along", async () => {
  renderEditor(respond);
  const save = saving();
  const panel = await open();
  fireEvent.click(within(panel).getByRole("button", { name: "Use cases" }));
  // The first answers with the first answer the step was joined to, and the
  // other gets a case of its own; each waits for its condition.
  expect(await screen.findByRole("tab", { name: "Case 1" })).toBeTruthy();
  expect(field("Case 1 body")).toHaveProperty("value", "{ 'id': 1 }");
  expect(field("Case 1 status")).toHaveProperty("value", "200");
  tab("Case 2");
  expect(field("Case 2 status")).toHaveProperty("value", "400");
  expect(blocks()).toEqual([
    "case:0 Case 1 · 200",
    "case:1 Case 2 · 400",
    "add + Case",
  ]);
  const draft = await save();
  expect(draft?.response?.answers).toEqual([
    { status: 200, from: "respond", on: 200 },
    { status: 400, from: "respond", on: 400 },
  ]);
});

test("a case's tab names it and sets its exit code, and moves and removes it, its lines going along", async () => {
  renderEditor(cased);
  const save = saving();
  await open();
  tab("found");
  type("Case 1 name", "ok");
  await waitFor(() => expect(blocks()[0]).toBe("case:0 ok · 200"));
  expect(screen.getByRole("tab", { name: "ok" })).toBeTruthy();

  tab("missing");
  // A code another case has is refused, and the one held stays.
  type("Case 2 status", "200");
  expect(screen.getByText("ok exits with 200.")).toBeTruthy();
  expect(blocks()[1]).toBe("case:1 missing · 404");
  type("Case 2 status", "410");
  await waitFor(() => expect(blocks()[1]).toBe("case:1 missing · 410"));

  // The first case that holds exits, so their order matters; its tab stays
  // open as it moves.
  fireEvent.click(screen.getByRole("button", { name: "Move case 2 up" }));
  await waitFor(() => expect(blocks()[0]).toBe("case:0 missing · 410"));
  expect(screen.getByRole("tab", { name: "missing" }).ariaSelected).toBe(
    "true",
  );
  tab("ok");
  fireEvent.click(screen.getByRole("button", { name: "Remove case 2" }));
  await waitFor(() =>
    expect(blocks()).toEqual(["case:0 missing · 410", "add + Case"]),
  );
  // The one case left stays: a step with cases has one.
  expect(screen.getByRole("button", { name: "Remove case 1" })).toHaveProperty(
    "disabled",
    true,
  );
  const draft = await save();
  expect(draft?.edges).toEqual([{ from: "respond", to: "fallback", on: 410 }]);
  expect(draft?.response?.answers).toEqual([
    { status: 200 },
    { status: 500, from: "respond", unhandled: true },
  ]);
});

test("+ Case adds a case, named, with a code no exit has, and opens its tab", async () => {
  renderEditor(cased);
  await open();
  tab("Add a case");
  // The first answer's status no case has.
  expect(field("New case status")).toHaveProperty("value", "500");
  type("New case name", "bad_key");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "bad_key" }).ariaSelected).toBe(
      "true",
    ),
  );
  expect(blocks()).toEqual([
    "case:0 found · 200",
    "case:1 missing · 404",
    "case:2 bad_key · 500",
    "add + Case",
  ]);
});

test("a status that isn't 200 to 599 says so, and the one held stays", async () => {
  renderEditor(cased);
  await open();
  type("Case 1 status", "99");
  expect(screen.getByText("A whole number from 200 to 599.")).toBeTruthy();
  expect(blocks()[0]).toBe("case:0 found · 200");
  type("Case 1 status", "201");
  await waitFor(() => expect(blocks()[0]).toBe("case:0 found · 201"));
});

test("each tab reads for itself: a field picked goes where its cursor was last, and it says whether its case holds", async () => {
  renderEditor({
    nodes: [
      {
        id: "respond",
        kind: "transform",
        switch: {
          cases: [
            { when: "", status: 400 },
            { when: "true", status: 200, body: "{ 'ok': true }" },
          ],
        },
      },
    ],
  });
  server.use(
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: { key: 1 }, nodes: {} },
        gives: { status: 400, body: { error: "bad key" } },
        skipped: false,
        problems: [],
      }),
    ),
  );
  const panel = await open();
  const insert = () =>
    within(panel).getByRole("button", { name: "Insert input.key" });
  // The tabs come first, and what the step reads is in each.
  expect(
    within(within(panel).getByRole("tabpanel")).getByRole("heading", {
      name: "Input",
    }),
  ).toBeTruthy();
  await within(panel).findByRole("button", { name: "Insert input.key" });
  // Before any field in the tab has had the cursor, its condition.
  fireEvent.click(insert());
  await waitFor(() =>
    expect(field("Case 1 when")).toHaveProperty("value", "input.key"),
  );
  // What it gives over the samples: this case holds.
  expect(
    within(panel).getByRole("heading", { name: "It answers 400" }),
  ).toBeTruthy();
  expect(within(panel).getByText(/"error": "bad key"/)).toBeTruthy();
  // In Case 2's tab, where its cursor is; Case 1's condition keeps what it
  // had.
  tab("Case 2");
  const body = field("Case 2 body") as HTMLTextAreaElement; // a textbox, by its role
  fireEvent.focus(body);
  body.setSelectionRange(0, 0);
  fireEvent.click(insert());
  await waitFor(() => expect(body.value).toBe("input.key{ 'ok': true }"));
  tab("Case 1");
  expect(field("Case 1 when")).toHaveProperty("value", "input.key");
  tab("Case 2");
  expect(
    within(panel).getByText("With these samples, Case 1 holds, not this."),
  ).toBeTruthy();
});

test("a body that sends what the run read is warned about", async () => {
  renderEditor({
    nodes: [
      {
        id: "respond",
        kind: "transform",
        switch: {
          cases: [{ when: "true", status: 200, body: "nodes.user.body" }],
        },
      },
    ],
  });
  const panel = await open();
  expect(within(panel).queryByText(/^This sends callers/)).toBeNull();
  type("Case 1 body", "{ 'debug': $$ }");
  expect(within(panel).getByText(/^This sends callers/)).toBeTruthy();
  type("Case 1 body", "{ 'trace': nodes.user.headers }");
  expect(within(panel).getByText(/^This sends callers/)).toBeTruthy();
  type("Case 1 body", "$$.input.id");
  expect(within(panel).queryByText(/^This sends callers/)).toBeNull();
});

test("with no case holding over the samples, each tab says the step fails into its Unhandled", async () => {
  renderEditor(cased);
  server.use(
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: { id: null }, nodes: {} },
        skipped: false,
        problems: [
          {
            pointer: "/nodes/0/switch",
            code: "evaluation_failed",
            detail: "no case holds",
          },
        ],
      }),
    ),
  );
  const panel = await open();
  // Each case's tab, the hidden one too.
  expect(
    await within(panel).findAllByText(
      "With these samples, no case holds: the step fails, and its Unhandled takes that.",
    ),
  ).toHaveLength(2);
});

const at = (ms: number) =>
  new Date(Date.UTC(2026, 10, 1, 20, 0, 0, ms)).toISOString();

// A run in which input.id was 7, so found held, a 2xx case, and the run
// answered 200 from its exit; fallback, after missing's, was skipped.
const ran: Run = {
  id: "r-1",
  workflow_id: "wf-1",
  revision: 1,
  trigger: "editor",
  status: "succeeded",
  answered: 200,
  started_at: at(0),
  ended_at: at(30),
  input: { id: 7 },
  nodes: [
    {
      node: "respond",
      status: "succeeded",
      attempts: 0,
      ended_at: at(10),
      response: { status: 200, body: { id: 7 } },
    },
    { node: "fallback", status: "skipped", attempts: 0, ended_at: at(20) },
  ],
};

test("a run marks the case that held, and takes the lines leaving its exit", async () => {
  renderEditor(cased);
  server.use(
    http.post("/api/v1/workflows/wf-1/runs", () =>
      HttpResponse.json<Run>({ ...ran, status: "running" }, { status: 202 }),
    ),
    http.get(
      "/api/v1/runs/r-1/events",
      () =>
        new HttpResponse(
          `event: run\nid: end\ndata: ${JSON.stringify({ ...ran, nodes: undefined })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    ),
    http.get("/api/v1/runs/r-1", () => HttpResponse.json<Run>(ran)),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  const dialog = await screen.findByRole("dialog", { name: "Run" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
  await waitFor(() =>
    expect(blocks()[0]).toBe("case:0 found · 200, the case that held"),
  );
  expect(blocks()[1]).toBe("case:1 missing · 404");
  // Its 2xx exit is its own, not every 2xx the step might give.
  await waitFor(() =>
    expect(
      screen
        .getByTestId("rf__edge-respond->#response:0")
        .getAttribute("aria-label"),
    ).toBe("Connection from respond to the 200 answer, taken in this run"),
  );
  expect(
    screen.getByTestId("rf__edge-respond->fallback").getAttribute("aria-label"),
  ).toBe("Connection from respond to fallback, not taken in this run");
  const panel = await open();
  expect(await within(panel).findByText("It gave 200")).toBeTruthy();
});
