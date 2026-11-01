import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { workflowRevision } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type NodeEvent = components["schemas"]["NodeEvent"];
type Preview = components["schemas"]["Preview"];
type PreviewRequest = components["schemas"]["PreviewRequest"];
type Revision = components["schemas"]["Revision"];
type Run = components["schemas"]["Run"];

shimReactFlow();

// prefs answers 2xx or 400; on 400, fallback gets them another way.
// prefs_ok, a transform, takes whichever came, and greet follows it.
const merged: Definition = {
  nodes: [
    {
      id: "prefs",
      kind: "http",
      request: { method: "GET", url: "https://prefs.example.com/v1/7" },
      outputs: [{ status: 400 }],
    },
    {
      id: "fallback",
      kind: "http",
      request: { method: "GET", url: "https://prefs.example.com/v1/defaults" },
    },
    {
      id: "prefs_ok",
      kind: "transform",
      expr: "$exists(nodes.fallback) ? nodes.fallback.body.data : nodes.prefs.body",
    },
    { id: "greet", kind: "transform", expr: "nodes.prefs_ok.body.theme" },
  ],
  edges: [
    { from: "prefs", to: "prefs_ok" },
    { from: "prefs", to: "fallback", on: 400 },
    { from: "fallback", to: "prefs_ok" },
    { from: "prefs_ok", to: "greet" },
  ],
};

// open picks a step on the canvas, and gives its panel.
async function open(id: string) {
  fireEvent.click(
    within(await screen.findByTestId(`rf__node-${id}`)).getByText(id),
  );
  return screen.findByRole("complementary", { name: "Transform step" });
}

test("there's no Merge step to add: a transform takes whichever of its lines came", async () => {
  renderEditor(merged);
  expect(
    await screen.findByRole("button", { name: "Add transform step" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
});

test("lines into a transform with several are dashed, as each may not come; a lone line isn't", async () => {
  renderEditor(merged);
  const way = await screen.findByTestId("rf__edge-prefs->prefs_ok");
  expect(way.classList.contains("way")).toBe(true);
  expect(way.getAttribute("aria-label")).toBe(
    "Connection from prefs to prefs_ok, one of its ways",
  );
  expect(
    screen.getByTestId("rf__edge-fallback->prefs_ok").classList.contains("way"),
  ).toBe(true);
  const needed = screen.getByTestId("rf__edge-prefs_ok->greet");
  expect(needed.classList.contains("way")).toBe(false);
});

test("a way's Required says, when asked, what marking it does", async () => {
  renderEditor(merged);
  fireEvent.click(await screen.findByTestId("rf__edge-prefs->prefs_ok"));
  const way = await screen.findByRole("complementary", { name: "Connection" });
  expect(
    within(way)
      .getByRole("checkbox", { name: "Required" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  fireEvent.click(within(way).getByRole("button", { name: "About Required" }));
  expect(
    await screen.findByText(
      "prefs_ok runs only once this line came, so its expression can read prefs without checking. Unmarked, prefs_ok may run without it, once another line came.",
    ),
  ).toBeTruthy();
});

// previewing answers each preview with preview, and gives what was asked.
function previewing(preview: Preview): PreviewRequest[] {
  const asked: PreviewRequest[] = [];
  server.use(
    http.post<PathParams, PreviewRequest, Preview>(
      "/api/v1/preview",
      async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json<Preview>(preview);
      },
    ),
  );
  return asked;
}

// The runs by prefs' 2xx and by fallback, merged: prefs as the first read
// it, and fallback.
const mergedReads = {
  input: null,
  nodes: {
    prefs: { status: 200, body: { theme: "dark" } },
    fallback: { status: 200, body: { data: { theme: "light" } } },
  },
};

// A transform's preview gives one value, the first run's that comes (plan
// 13): which way a run came by is the transform's to decide.
test("its preview reads what the runs by each way read, merged, and gives the first's value", async () => {
  renderEditor(merged);
  const asked = previewing({
    reads: mergedReads,
    ways: [
      { edge: 0, gives: { theme: "dark" }, skipped: false },
      { edge: 2, gives: { theme: "light" }, skipped: false },
    ],
    skipped: false,
    problems: [],
  });
  const panel = await open("prefs_ok");
  expect(await within(panel).findByText(/"theme": "dark"/)).toBeTruthy();
  expect(within(panel).queryByText(/"theme": "light"/)).toBeNull();
  // There's no run to pick: the preview is of each, asked of the step.
  expect(within(panel).queryByText("Preview a run that comes by")).toBeNull();
  expect(Object.keys(asked.at(-1) ?? {})).toEqual(["definition", "node"]);
  // It reads fallback, there only in the run by it.
  expect(within(panel).getByText("fallback")).toBeTruthy();
});

test("a way no run comes by gives way to the next, and a run that gives nothing says so", async () => {
  renderEditor(merged);
  previewing({
    reads: mergedReads,
    ways: [
      { edge: 0, skipped: true },
      { edge: 2, gives: { theme: "light" }, skipped: false },
    ],
    skipped: false,
    problems: [],
  });
  const panel = await open("prefs_ok");
  expect(await within(panel).findByText(/"theme": "light"/)).toBeTruthy();

  previewing({
    reads: mergedReads,
    ways: [
      { edge: 0, skipped: false },
      { edge: 2, gives: { theme: "light" }, skipped: false },
    ],
    skipped: false,
    problems: [],
  });
  fireEvent.change(within(panel).getByRole("textbox", { name: "Expression" }), {
    target: { value: "nodes.prefs.body.none" },
  });
  expect(await within(panel).findByText("Nothing.")).toBeTruthy();
  expect(within(panel).queryByText(/"theme": "light"/)).toBeNull();
});

test("a transform with one line into it previews one run", async () => {
  renderEditor(merged);
  const asked = previewing({
    reads: { input: null, nodes: {} },
    gives: "dark",
    skipped: false,
    problems: [],
  });
  const panel = await open("greet");
  expect(
    await within(panel).findByRole("heading", { name: "Gives" }),
  ).toBeTruthy();
  expect(within(panel).getByText('"dark"')).toBeTruthy();
  expect(asked.at(-1)?.node).toBe("greet");
});

// prefs_ok with cases: dark answers 200, light 201.
const cased: Definition = {
  ...merged,
  nodes: merged.nodes.map((n) =>
    n.id === "prefs_ok"
      ? {
          id: "prefs_ok",
          kind: "transform",
          switch: {
            cases: [
              {
                name: "dark",
                when: "$exists(nodes.prefs.body.theme)",
                status: 200,
                body: "nodes.prefs.body",
              },
              {
                name: "light",
                when: "$exists(nodes.fallback)",
                status: 201,
                body: "nodes.fallback.body.data",
              },
            ],
          },
        }
      : n,
  ),
  edges: (merged.edges ?? []).map((e) =>
    e.from === "prefs_ok" ? { ...e, on: 200 } : e,
  ),
};

test("each case's tab says what the first run that comes gives, or which case holds instead", async () => {
  renderEditor(cased);
  previewing({
    reads: mergedReads,
    ways: [
      {
        edge: 0,
        gives: { status: 200, body: { theme: "dark" } },
        skipped: false,
      },
      { edge: 2, gives: { status: 201 }, skipped: false },
    ],
    skipped: false,
    problems: [],
  });
  const panel = await open("prefs_ok");
  const shown = () =>
    panel.querySelector<HTMLElement>("[role=tabpanel]:not([hidden])") ?? panel;
  expect(
    await within(shown()).findByRole("heading", { name: "Gives 200" }),
  ).toBeTruthy();
  expect(within(shown()).getByText(/"theme": "dark"/)).toBeTruthy();

  fireEvent.click(within(panel).getByRole("tab", { name: "light" }));
  await waitFor(() =>
    expect(within(shown()).getByText("dark holds, not this.")).toBeTruthy(),
  );
});

test("a case that holds with no body says so", async () => {
  renderEditor(cased);
  previewing({
    reads: mergedReads,
    ways: [
      { edge: 0, skipped: true },
      { edge: 2, gives: { status: 201 }, skipped: false },
    ],
    skipped: false,
    problems: [],
  });
  const panel = await open("prefs_ok");
  fireEvent.click(within(panel).getByRole("tab", { name: "light" }));
  const shown = () =>
    panel.querySelector<HTMLElement>("[role=tabpanel]:not([hidden])") ?? panel;
  expect(
    await within(shown()).findByRole("heading", { name: "Gives 201" }),
  ).toBeTruthy();
  expect(within(shown()).getByText("No body.")).toBeTruthy();
});

test("a case's tab says when no case holds", async () => {
  renderEditor(cased);
  previewing({
    reads: mergedReads,
    ways: [
      { edge: 0, skipped: false },
      { edge: 2, skipped: true },
    ],
    skipped: false,
    problems: [
      {
        pointer: "/nodes/2/switch",
        code: "evaluation_failed",
        detail: "no case holds",
      },
    ],
  });
  const panel = await open("prefs_ok");
  const shown = () =>
    panel.querySelector<HTMLElement>("[role=tabpanel]:not([hidden])") ?? panel;
  expect(
    await within(shown()).findByText("No case holds with these samples."),
  ).toBeTruthy();
});

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

test("a line into a transform marked required is drawn solid, and saved so", async () => {
  renderEditor(merged);
  const save = saving();
  fireEvent.click(await screen.findByTestId("rf__edge-fallback->prefs_ok"));
  const panel = await screen.findByRole("complementary", {
    name: "Connection",
  });
  const required = within(panel).getByRole("checkbox", { name: "Required" });
  expect(required.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(required);
  await waitFor(() =>
    expect(required.getAttribute("aria-checked")).toBe("true"),
  );
  const line = screen.getByTestId("rf__edge-fallback->prefs_ok");
  expect(line.classList.contains("way")).toBe(false);
  expect(line.getAttribute("aria-label")).not.toContain("one of its ways");
  // The line beside it may still not come.
  expect(
    screen.getByTestId("rf__edge-prefs->prefs_ok").classList.contains("way"),
  ).toBe(true);
  const draft = await save();
  expect(draft?.edges?.[2]).toEqual({
    from: "fallback",
    to: "prefs_ok",
    required: true,
  });
});

test("unmarking a line leaves no required in the draft", async () => {
  renderEditor({
    ...merged,
    edges: (merged.edges ?? []).map((e, i) =>
      i === 2 ? { ...e, required: true } : e,
    ),
  });
  const save = saving();
  fireEvent.click(await screen.findByTestId("rf__edge-fallback->prefs_ok"));
  const required = within(
    await screen.findByRole("complementary", { name: "Connection" }),
  ).getByRole("checkbox", { name: "Required" });
  expect(required.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(required);
  await waitFor(() =>
    expect(
      screen
        .getByTestId("rf__edge-fallback->prefs_ok")
        .classList.contains("way"),
    ).toBe(true),
  );
  const draft = await save();
  expect(draft?.edges?.[2]).toEqual({ from: "fallback", to: "prefs_ok" });
});

test("a line into an HTTP step has no Required: it needs every line", async () => {
  renderEditor(merged);
  fireEvent.click(await screen.findByTestId("rf__edge-prefs->fallback"));
  const panel = await screen.findByRole("complementary", {
    name: "Connection",
  });
  expect(within(panel).queryByRole("checkbox")).toBeNull();
});

test("a line into an HTTP step marked required shows Required with its problem, so the mark can come off", async () => {
  const marked: Definition = {
    ...merged,
    edges: (merged.edges ?? []).map((e, i) =>
      i === 1 ? { ...e, required: true } : e,
    ),
  };
  renderEditor(marked, [
    {
      pointer: "/edges/1/required",
      code: "not_allowed",
      detail:
        "an http node needs every edge into it; required is for a transform's",
    },
  ]);
  // The list names it, and takes the cursor to it.
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(
    within(list).getByRole("button", {
      name: /^Connection prefs \(400\) → fallback · Required/,
    }),
  );
  const panel = await screen.findByRole("complementary", {
    name: "Connection",
  });
  const required = within(panel).getByRole("checkbox", { name: "Required" });
  await waitFor(() => expect(document.activeElement).toBe(required));
  expect(required.getAttribute("aria-invalid")).toBe("true");
  expect(
    within(panel).getByText(
      "An HTTP step needs every connection into it, so none is marked required: that's for a transform step's.",
    ),
  ).toBeTruthy();
});

const at = (ms: number) =>
  new Date(Date.UTC(2026, 10, 1, 20, 0, 0, ms)).toISOString();

// ran is a run in which prefs answered 400, so prefs_ok came by fallback:
// each step says which lines its answer took.
const ran: Run = {
  id: "r-1",
  workflow_id: "wf-1",
  revision: 1,
  trigger: "editor",
  status: "succeeded",
  started_at: at(0),
  ended_at: at(300),
  input: null,
  nodes: [
    {
      node: "prefs",
      status: "succeeded",
      attempts: 1,
      ended_at: at(80),
      response: { status: 400, body: null },
      took: [{ to: "fallback", on: 400 }],
    },
    {
      node: "fallback",
      status: "succeeded",
      attempts: 1,
      ended_at: at(160),
      response: { status: 200, body: { data: { theme: "light" } } },
      took: [{ to: "prefs_ok" }],
    },
    {
      node: "prefs_ok",
      status: "succeeded",
      attempts: 0,
      ended_at: at(170),
      response: { body: { theme: "light" } },
      took: [{ to: "greet" }],
    },
    {
      node: "greet",
      status: "succeeded",
      attempts: 0,
      ended_at: at(180),
      response: { body: "light" },
    },
  ],
};

// serveRun answers the run's start, its events, ending with the run, and the
// run itself.
function serveRun(ran: Run) {
  const events: NodeEvent[] = (ran.nodes ?? []).map((n) => ({
    node: n.node,
    kind: n.status,
    attempt: n.attempts,
    at: n.ended_at,
    ...(n.took ? { took: n.took } : {}),
  }));
  const encoder = new TextEncoder();
  const text = [
    ...events.map(
      (e, i) => `event: node\nid: ${i + 1}\ndata: ${JSON.stringify(e)}\n\n`,
    ),
    `event: run\nid: end\ndata: ${JSON.stringify({ ...ran, nodes: undefined })}\n\n`,
  ];
  server.use(
    http.post("/api/v1/workflows/wf-1/runs", () =>
      HttpResponse.json<Run>({ ...ran, status: "running" }, { status: 202 }),
    ),
    http.get(
      "/api/v1/runs/r-1/events",
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              for (const t of text) controller.enqueue(encoder.encode(t));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    ),
    http.get("/api/v1/runs/r-1", () => HttpResponse.json<Run>(ran)),
  );
}

test("a run draws the lines a transform came by solid, the others dashed, and its panel names them", async () => {
  renderEditor(merged);
  serveRun(ran);
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  const dialog = await screen.findByRole("dialog", { name: "Run" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));

  const came = await screen.findByTestId("rf__edge-fallback->prefs_ok");
  await waitFor(() =>
    expect(came.getAttribute("aria-label")).toBe(
      "Connection from fallback to prefs_ok, taken in this run",
    ),
  );
  expect(
    [...came.classList].filter((c) => c === "way" || c === "untaken"),
  ).toEqual([]);
  const other = screen.getByTestId("rf__edge-prefs->prefs_ok");
  expect(other.getAttribute("aria-label")).toBe(
    "Connection from prefs to prefs_ok, not taken in this run",
  );
  expect(other.classList.contains("untaken")).toBe(true);

  const panel = await open("prefs_ok");
  expect(
    await within(panel).findByText(
      (_text, el) => el?.textContent === "It came by fallback · 2xx.",
    ),
  ).toBeTruthy();
  // greet has one line in, so how it came goes without saying.
  const after = await open("greet");
  expect(await within(after).findByText("It gave")).toBeTruthy();
  expect(within(after).queryByText(/^It came by/)).toBeNull();
});

// count fails into its Unhandled, so counted comes by that, not by count's
// value: two ways from one step, told apart by the output each leaves.
test("a run tells apart two ways from one step", async () => {
  renderEditor({
    nodes: [
      { id: "count", kind: "transform", expr: "$number(input.n)" },
      { id: "counted", kind: "transform", expr: "0" },
    ],
    edges: [
      { from: "count", to: "counted" },
      { from: "count", to: "counted", unhandled: true },
    ],
  });
  serveRun({
    ...ran,
    nodes: [
      {
        node: "count",
        status: "failed",
        attempts: 0,
        ended_at: at(10),
        error: { code: "workflow_error", detail: "no number", caught: true },
        took: [{ to: "counted", unhandled: true }],
      },
      {
        node: "counted",
        status: "succeeded",
        attempts: 0,
        ended_at: at(20),
        response: { body: 0 },
      },
    ],
  });
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  const dialog = await screen.findByRole("dialog", { name: "Run" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
  const caught = await screen.findByTestId("rf__edge-count->counted#1");
  await waitFor(() =>
    expect(caught.getAttribute("aria-label")).toBe(
      "Connection from count to counted, taken in this run",
    ),
  );
  expect(
    screen.getByTestId("rf__edge-count->counted").getAttribute("aria-label"),
  ).toBe("Connection from count to counted, not taken in this run");
});

// With fallback's line required, a run in which prefs answered 2xx skips
// fallback, and so prefs_ok, but prefs took its line to prefs_ok all the
// same, and the canvas says so.
test("a line into a step the run skipped is taken when its step took it", async () => {
  renderEditor({
    ...merged,
    edges: (merged.edges ?? []).map((e, i) =>
      i === 2 ? { ...e, required: true } : e,
    ),
  });
  serveRun({
    ...ran,
    nodes: [
      {
        node: "prefs",
        status: "succeeded",
        attempts: 1,
        ended_at: at(80),
        response: { status: 200, body: { theme: "dark" } },
        took: [{ to: "prefs_ok" }],
      },
      { node: "fallback", status: "skipped", attempts: 0, ended_at: at(90) },
      { node: "prefs_ok", status: "skipped", attempts: 0, ended_at: at(90) },
      { node: "greet", status: "skipped", attempts: 0, ended_at: at(90) },
    ],
  });
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  const dialog = await screen.findByRole("dialog", { name: "Run" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
  const taken = await screen.findByTestId("rf__edge-prefs->prefs_ok");
  await waitFor(() =>
    expect(taken.getAttribute("aria-label")).toBe(
      "Connection from prefs to prefs_ok, taken in this run",
    ),
  );
  expect(
    screen
      .getByTestId("rf__edge-fallback->prefs_ok")
      .getAttribute("aria-label"),
  ).toBe("Connection from fallback to prefs_ok, not taken in this run");
});

test("its Input tags a step a run may come without, and one that may answer either way, and says what to check", async () => {
  renderEditor(merged);
  previewing({
    reads: mergedReads,
    ways: [
      { edge: 0, gives: { theme: "dark" }, skipped: false },
      { edge: 2, gives: { theme: "light" }, skipped: false },
    ],
    outcomes: {
      prefs: { outputs: [0, 400], conditional: false },
      fallback: { outputs: [0], conditional: true },
    },
    skipped: false,
    problems: [],
  });
  const panel = await open("prefs_ok");
  const beside = (path: string) =>
    within(panel).getByRole("button", { name: `Insert ${path}` }).parentElement
      ?.textContent;
  await waitFor(() =>
    expect(beside("nodes.fallback")).toBe("fallbackconditional"),
  );
  expect(beside("nodes.prefs")).toBe("prefs2xx or 400");
  // What a tag asks of an expression is the Input's hint.
  fireEvent.click(within(panel).getByRole("button", { name: "About Input" }));
  expect(
    await screen.findByText(
      /^The run's input, and what the steps before got back/,
    ),
  ).toBeTruthy();
});

test("its Input tags a step that may fail with its Unhandled, and one that's conditional too with both", async () => {
  renderEditor(merged);
  const step = (body: unknown) => ({ status: 200, body });
  previewing({
    reads: {
      input: null,
      nodes: { a: step(1), b: step(2), c: { body: 3 }, d: step(4), e: step(5) },
    },
    gives: "x",
    outcomes: {
      a: { outputs: [0], conditional: true },
      b: { outputs: [0], conditional: true },
      c: { outputs: [-1, 0], conditional: false },
      d: { outputs: [-1, 0], conditional: true },
    },
    skipped: false,
    problems: [],
  });
  const panel = await open("greet");
  // Each is folded, as greet has no line from it.
  const beside = (path: string) =>
    within(panel).getByRole("button", { name: `Insert ${path}` }).parentElement
      ?.textContent;
  await waitFor(() => expect(beside("nodes.a")).toBe("aconditional{…}"));
  expect(beside("nodes.b")).toBe("bconditional{…}");
  expect(beside("nodes.c")).toBe("cvalue or Unhandled{…}");
  expect(beside("nodes.d")).toBe("dconditional · value or Unhandled{…}");
  expect(beside("nodes.e")).toBe("e{…}");
});
