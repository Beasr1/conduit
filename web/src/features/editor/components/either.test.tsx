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
// prefs_ok, an Either, takes either, and greet follows it.
const eithered: Definition = {
  nodes: [
    prefs,
    {
      id: "fallback",
      kind: "http",
      request: { method: "GET", url: "https://prefs.example.com/v1/defaults" },
    },
    { id: "prefs_ok", kind: "either" },
    { id: "greet", kind: "transform", expr: "nodes.prefs_ok.body.theme" },
  ],
  edges: [
    { from: "prefs", to: "prefs_ok" },
    { from: "prefs", to: "fallback", on: 400 },
    { from: "fallback", to: "prefs_ok", body: "nodes.fallback.body.data" },
    { from: "prefs_ok", to: "greet" },
  ],
};

// blocks is what a card's blocks say, in order.
const blocks = (card: HTMLElement) =>
  [...card.querySelectorAll("[data-part]")].map((b) => b.textContent);

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

// selected is the name of the tab open in panel.
const selected = (panel: HTMLElement) =>
  within(panel)
    .getAllByRole("tab")
    .find((t) => t.getAttribute("aria-selected") === "true")?.textContent;

test("an Either step is added with + Add for its ways, and opens on adding one", async () => {
  renderEditor({ nodes: [prefs] });
  fireEvent.click(
    await screen.findByRole("button", { name: "Add Either step" }),
  );
  fireEvent.change(screen.getByLabelText("Id"), {
    target: { value: "prefs_ok" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const card = await screen.findByTestId("rf__node-prefs_ok");
  expect(blocks(card)).toEqual(["+ Add", "Unhandled · fails the run"]);
  expect(within(card).getByText("Either")).toBeTruthy();

  // Picked, with no way yet, it opens on adding one.
  fireEvent.click(within(card).getByText("Either"));
  const panel = await screen.findByRole("complementary", {
    name: "Either step",
  });
  expect(selected(panel)).toBe("+ Way");
  await choose("Add a way from", "prefs · 2xx");
  await waitFor(() =>
    expect(blocks(card)).toEqual([
      "prefs · 2xx",
      "+ Add",
      "Unhandled · fails the run",
    ]),
  );
  expect(await screen.findByTestId("rf__edge-prefs->prefs_ok")).toBeTruthy();
  expect(selected(panel)).toBe("prefs · 2xx");
});

test("each way is a block that opens its tab, where the value it gives is written", async () => {
  renderEditor(eithered);
  const asked: PreviewRequest[] = [];
  server.use(
    http.post<PathParams, PreviewRequest, Preview>(
      "/api/v1/preview",
      async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json<Preview>({
          reads: {
            input: null,
            nodes: {
              fallback: { status: 200, body: { data: { theme: "light" } } },
            },
          },
          taken: true,
          gives: { theme: "light" },
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
        const { revision } = workflowRevision("wf-1", "Either", draft);
        return HttpResponse.json<Revision>({ ...revision, revision: 2 });
      },
    ),
  );
  const card = await screen.findByTestId("rf__node-prefs_ok");
  expect(blocks(card)).toEqual([
    "prefs · 2xx",
    "fallback · 2xx",
    "+ Add",
    "Unhandled · fails the run",
  ]);

  fireEvent.click(within(card).getByText("fallback · 2xx"));
  const panel = await screen.findByRole("complementary", {
    name: "Either step",
  });
  expect(selected(panel)).toBe("fallback · 2xx");
  const value = within(panel).getByRole("textbox", { name: "Value" });
  expect(value).toHaveProperty("value", "nodes.fallback.body.data");
  // What it gives over the samples is the way's connection's preview, in
  // the tab open: the others stay mounted.
  const open = within(panel).getByRole("tabpanel");
  expect(await within(open).findByText("It gives")).toBeTruthy();
  expect(within(open).getByText(/"theme": "light"/)).toBeTruthy();
  expect(asked.at(-1)?.edge).toBe(2);

  fireEvent.change(value, { target: { value: "nodes.fallback.body.prefs" } });
  // prefs' way gives prefs' body as it is, having no value of its own.
  fireEvent.click(within(panel).getByRole("tab", { name: "prefs · 2xx" }));
  expect(within(panel).getByRole("textbox", { name: "Value" })).toHaveProperty(
    "value",
    "",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]?.edges?.[2]).toEqual({
    from: "fallback",
    to: "prefs_ok",
    body: "nodes.fallback.body.prefs",
  });
});

test("a way is dashed, as it may not be taken; a line into any other step isn't", async () => {
  renderEditor(eithered);
  const way = await screen.findByTestId("rf__edge-prefs->prefs_ok");
  expect(way.classList.contains("way")).toBe(true);
  expect(way.getAttribute("aria-label")).toBe(
    "Connection from prefs to prefs_ok, one of its ways",
  );
  const needed = screen.getByTestId("rf__edge-prefs_ok->greet");
  expect(needed.classList.contains("way")).toBe(false);
});

test("+ Way offers each response that could join it, and opens the one picked", async () => {
  renderEditor(eithered);
  const card = await screen.findByTestId("rf__node-prefs_ok");
  fireEvent.click(within(card).getByText("+ Add"));
  const panel = await screen.findByRole("complementary", {
    name: "Either step",
  });
  expect(selected(panel)).toBe("+ Way");
  // Not the ways it has, nor greet, which follows it.
  expect(await options("Add a way from")).toEqual([
    "prefs · 400",
    "prefs · Unhandled",
    "fallback · Unhandled",
  ]);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  await choose("Add a way from", "fallback · Unhandled");
  expect(
    await screen.findByTestId("rf__edge-fallback->prefs_ok#1"),
  ).toBeTruthy();
  await waitFor(() => expect(selected(panel)).toBe("fallback · Unhandled"));
});

test("a way's connection says it's one, and opens the value it gives", async () => {
  renderEditor(eithered);
  fireEvent.click(await screen.findByTestId("rf__edge-fallback->prefs_ok"));
  const connection = await screen.findByRole("complementary", {
    name: "Connection",
  });
  expect(
    within(connection).getByText(/^It's a way into prefs_ok, an Either step/),
  ).toBeTruthy();
  fireEvent.click(
    within(connection).getByRole("button", { name: "Edit the value it gives" }),
  );
  const panel = await screen.findByRole("complementary", {
    name: "Either step",
  });
  expect(selected(panel)).toBe("fallback · 2xx");
});

test("a problem with a way's value marks its tab, and opens it from the list", async () => {
  renderEditor(eithered, [
    {
      pointer: "/edges/2/body",
      code: "invalid_expression",
      detail: "JSONata error S0201: syntax error",
    },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(
    within(list).getByRole("button", {
      name: /^Connection fallback → prefs_ok · Value/,
    }),
  );
  const panel = await screen.findByRole("complementary", {
    name: "Either step",
  });
  expect(selected(panel)).toBe("fallback · 2xx (1 problem)");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(panel).getByRole("textbox", { name: "Value" }),
    ),
  );
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
      way: { from: "fallback" },
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
    ...(n.way ? { way: n.way } : {}),
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

test("a run marks the way that came, and the line it came by", async () => {
  renderEditor(eithered);
  serveRun();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  const dialog = await screen.findByRole("dialog", { name: "Run" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));

  const card = await screen.findByTestId("rf__node-prefs_ok");
  await waitFor(() =>
    expect(
      card.querySelector('[data-part="way:fallback:0"]')?.textContent,
    ).toBe("fallback · 2xx, the way that came"),
  );
  expect(card.querySelector('[data-part="way:prefs:0"]')?.textContent).toBe(
    "prefs · 2xx",
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

  fireEvent.click(within(card).getByText("prefs · 2xx"));
  const panel = await screen.findByRole("complementary", {
    name: "Either step",
  });
  expect(
    await within(panel).findByText(
      (_text, el) => el?.textContent === "It came by fallback · 2xx.",
    ),
  ).toBeTruthy();
});
