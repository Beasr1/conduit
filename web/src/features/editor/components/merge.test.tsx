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

const prefs = {
  id: "prefs",
  kind: "http",
  request: { method: "GET", url: "https://prefs.example.com/v1/7" },
  outputs: [{ status: 400 }],
} satisfies Definition["nodes"][number];

// prefs answers 2xx or 400; on 400, fallback gets them another way.
// prefs_ok, a Merge, takes whichever came, and greet follows it.
const merged: Definition = {
  nodes: [
    prefs,
    {
      id: "fallback",
      kind: "http",
      request: { method: "GET", url: "https://prefs.example.com/v1/defaults" },
    },
    {
      id: "prefs_ok",
      kind: "merge",
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

// ways is what a Merge card's blocks on its left say, its ways then + Add:
// each holds a point.
const ways = (card: HTMLElement) =>
  [...card.querySelectorAll(".block-point")].map(
    (point) => point.parentElement?.textContent,
  );

// options opens a select from the keyboard, as a screen reader would, and
// gives what it offers.
async function options(label: string) {
  const select = screen.getByRole("combobox", { name: label });
  select.focus();
  fireEvent.keyDown(select, { key: "ArrowDown" });
  return (await screen.findAllByRole("option")).map((o) => o.textContent);
}

// choose picks an option from the keyboard: down to it, then Enter. A click
// on any but the first does nothing in jsdom.
async function choose(label: string, option: string) {
  const offered = await options(label);
  const k = offered.indexOf(option);
  expect(k, `${label} offers ${offered.join(", ")}`).toBeGreaterThanOrEqual(0);
  for (let i = 0; i <= k; i++)
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "ArrowDown",
    });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter" });
}

test("a Merge step is added with + Add for its ways and an expression to write", async () => {
  renderEditor({ nodes: [prefs] });
  fireEvent.click(
    await screen.findByRole("button", { name: "Add Merge step" }),
  );
  fireEvent.change(screen.getByLabelText("Id"), {
    target: { value: "prefs_ok" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const card = await screen.findByTestId("rf__node-prefs_ok");
  expect(ways(card)).toEqual(["+ Add"]);
  expect(within(card).getByText("Merge")).toBeTruthy();
  expect(card.querySelector('[data-part="unhandled"]')?.textContent).toBe(
    "Unhandled · fails the run",
  );

  fireEvent.click(within(card).getByText("Merge"));
  const panel = await screen.findByRole("complementary", {
    name: "Merge step",
  });
  expect(within(panel).getByText(/^None yet: add one below/)).toBeTruthy();
  expect(
    within(panel).getByRole("textbox", { name: "Expression" }),
  ).toHaveProperty("value", "");
  await choose("Add a way from", "prefs · 2xx");
  await waitFor(() => expect(ways(card)).toEqual(["prefs · 2xx", "+ Add"]));
  expect(await screen.findByTestId("rf__edge-prefs->prefs_ok")).toBeTruthy();
  expect(
    within(panel).getByRole("button", { name: "Way from prefs · 2xx always" }),
  ).toBeTruthy();
});

test("its expression makes its value from whatever came, previewed over the samples", async () => {
  renderEditor(merged);
  const asked: PreviewRequest[] = [];
  server.use(
    http.post<PathParams, PreviewRequest, Preview>(
      "/api/v1/preview",
      async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json<Preview>({
          reads: {
            input: null,
            nodes: { prefs: { status: 200, body: { theme: "dark" } } },
          },
          gives: { theme: "dark" },
          skipped: false,
          problems: [],
        });
      },
    ),
  );
  const saved: Definition[] = [];
  server.use(
    http.put<PathParams, Definition, Revision>(
      "/api/v1/workflows/wf-1/draft",
      async ({ request }) => {
        const draft = await request.json();
        saved.push(draft);
        const { revision } = workflowRevision("wf-1", "Merge", draft);
        return HttpResponse.json<Revision>({ ...revision, revision: 2 });
      },
    ),
  );
  const card = await screen.findByTestId("rf__node-prefs_ok");
  expect(ways(card)).toEqual(["prefs · 2xx", "fallback · 2xx", "+ Add"]);

  fireEvent.click(within(card).getByText("Merge"));
  const panel = await screen.findByRole("complementary", {
    name: "Merge step",
  });
  const expr = within(panel).getByRole("textbox", { name: "Expression" });
  expect(expr).toHaveProperty("value", merged.nodes[2]?.expr);
  expect(await within(panel).findByText("It gives")).toBeTruthy();
  expect(within(panel).getByText(/"theme": "dark"/)).toBeTruthy();
  expect(asked.at(-1)?.node).toBe("prefs_ok");

  fireEvent.change(expr, { target: { value: "nodes.prefs.body" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]?.nodes[2]).toEqual({
    id: "prefs_ok",
    kind: "merge",
    expr: "nodes.prefs.body",
  });
});

test("its ways each open their line, and + Way offers what could join it", async () => {
  renderEditor(merged);
  fireEvent.click(
    within(await screen.findByTestId("rf__node-prefs_ok")).getByText("Merge"),
  );
  const panel = await screen.findByRole("complementary", {
    name: "Merge step",
  });
  // Not the ways it has, nor greet, which follows it.
  expect(await options("Add a way from")).toEqual([
    "prefs · 400",
    "prefs · Unhandled",
    "fallback · Unhandled",
  ]);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

  fireEvent.click(
    within(panel).getByRole("button", {
      name: "Way from fallback · 2xx always",
    }),
  );
  const connection = await screen.findByRole("complementary", {
    name: "Connection",
  });
  expect(
    within(connection).getByText(
      /prefs_ok, a Merge step, runs if any of its ways is taken, once all have ended/,
    ),
  ).toBeTruthy();
});

test("a way is dashed, as it may not be taken; a line into any other step isn't", async () => {
  renderEditor(merged);
  const way = await screen.findByTestId("rf__edge-prefs->prefs_ok");
  expect(way.classList.contains("way")).toBe(true);
  expect(way.getAttribute("aria-label")).toBe(
    "Connection from prefs to prefs_ok, one of its ways",
  );
  const needed = screen.getByTestId("rf__edge-prefs_ok->greet");
  expect(needed.classList.contains("way")).toBe(false);
});

const at = (ms: number) =>
  new Date(Date.UTC(2026, 10, 1, 20, 0, 0, ms)).toISOString();

// ran is a run in which prefs answered 400, so prefs_ok came by fallback.
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
    },
    {
      node: "fallback",
      status: "succeeded",
      attempts: 1,
      ended_at: at(160),
      response: { status: 200, body: { data: { theme: "light" } } },
    },
    {
      node: "prefs_ok",
      status: "succeeded",
      attempts: 0,
      ended_at: at(170),
      response: { body: { theme: "light" } },
      ways: [{ from: "fallback" }],
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
function serveRun() {
  const events: NodeEvent[] = (ran.nodes ?? []).map((n) => ({
    node: n.node,
    kind: n.status,
    attempt: n.attempts,
    at: n.ended_at,
    ...(n.ways ? { ways: n.ways } : {}),
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

test("a run marks each way that came, and draws the lines they came by", async () => {
  renderEditor(merged);
  serveRun();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  const dialog = await screen.findByRole("dialog", { name: "Run" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));

  const card = await screen.findByTestId("rf__node-prefs_ok");
  await waitFor(() =>
    expect(ways(card)).toEqual([
      "prefs · 2xx",
      "fallback · 2xx, a way that came",
      "+ Add",
    ]),
  );
  // The way that came is drawn solid; the other is dashed as not taken.
  const came = screen.getByTestId("rf__edge-fallback->prefs_ok");
  expect(came.getAttribute("aria-label")).toBe(
    "Connection from fallback to prefs_ok, taken in this run",
  );
  expect(
    [...came.classList].filter((c) => c === "way" || c === "untaken"),
  ).toEqual([]);
  const other = screen.getByTestId("rf__edge-prefs->prefs_ok");
  expect(other.getAttribute("aria-label")).toBe(
    "Connection from prefs to prefs_ok, not taken in this run",
  );
  expect(other.classList.contains("untaken")).toBe(true);

  fireEvent.click(within(card).getByText("prefs_ok"));
  const panel = await screen.findByRole("complementary", {
    name: "Merge step",
  });
  expect(
    await within(panel).findByText(
      (_text, el) => el?.textContent === "It came by fallback · 2xx.",
    ),
  ).toBeTruthy();
});
