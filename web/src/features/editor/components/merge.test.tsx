import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { shimReactFlow } from "@/test/react-flow";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type NodeEvent = components["schemas"]["NodeEvent"];
type Preview = components["schemas"]["Preview"];
type PreviewRequest = components["schemas"]["PreviewRequest"];
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

test("a way's panel says the transform runs if any comes; a lone line's, that it needs it", async () => {
  renderEditor(merged);
  fireEvent.click(await screen.findByTestId("rf__edge-prefs->prefs_ok"));
  const way = await screen.findByRole("complementary", { name: "Connection" });
  expect(
    within(way).getByText(
      /prefs_ok, a transform, runs if any of its ways is taken, once all have ended/,
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByTestId("rf__edge-prefs_ok->greet"));
  await waitFor(() =>
    expect(
      within(
        screen.getByRole("complementary", { name: "Connection" }),
      ).getByText(
        /greet runs only when this is true and its other connections are taken/,
      ),
    ).toBeTruthy(),
  );
});

test("its preview comes by the way picked, its first at first", async () => {
  renderEditor(merged);
  const asked: PreviewRequest[] = [];
  server.use(
    http.post<PathParams, PreviewRequest, Preview>(
      "/api/v1/preview",
      async ({ request }) => {
        const body = await request.json();
        asked.push(body);
        const byFallback = body.way === 2;
        return HttpResponse.json<Preview>({
          reads: {
            input: null,
            nodes: byFallback
              ? {
                  prefs: { status: 400, body: { error: "no prefs yet" } },
                  fallback: { status: 200, body: { data: { theme: "light" } } },
                }
              : { prefs: { status: 200, body: { theme: "dark" } } },
          },
          gives: { theme: byFallback ? "light" : "dark" },
          skipped: false,
          problems: [],
        });
      },
    ),
  );
  const panel = await open("prefs_ok");
  expect(await within(panel).findByText(/"theme": "dark"/)).toBeTruthy();
  expect(asked.at(-1)).toMatchObject({ node: "prefs_ok", way: 0 });
  expect(await options("Preview a run that comes by")).toEqual([
    "prefs · 2xx",
    "fallback · 2xx",
  ]);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

  await choose("Preview a run that comes by", "fallback · 2xx");
  expect(await within(panel).findByText(/"theme": "light"/)).toBeTruthy();
  expect(asked.at(-1)).toMatchObject({ node: "prefs_ok", way: 2 });
  // What it reads is that run's: prefs answering 400, and fallback.
  expect(within(panel).getByText("fallback")).toBeTruthy();
});

test("a transform with one line into it previews without a way to pick", async () => {
  renderEditor(merged);
  const asked: PreviewRequest[] = [];
  server.use(
    http.post<PathParams, PreviewRequest, Preview>(
      "/api/v1/preview",
      async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json<Preview>({
          reads: { input: null, nodes: {} },
          gives: "dark",
          skipped: false,
          problems: [],
        });
      },
    ),
  );
  const panel = await open("greet");
  expect(await within(panel).findByText("It gives")).toBeTruthy();
  expect(
    within(panel).queryByRole("combobox", {
      name: "Preview a run that comes by",
    }),
  ).toBeNull();
  expect(asked.at(-1)?.way).toBeUndefined();
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
      ways: [{ from: "prefs_ok" }],
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
      },
      {
        node: "counted",
        status: "succeeded",
        attempts: 0,
        ended_at: at(20),
        response: { body: 0 },
        ways: [{ from: "count", unhandled: true }],
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
