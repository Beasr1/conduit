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
type Problem = components["schemas"]["Problem"];
type Revision = components["schemas"]["Revision"];
type Run = components["schemas"]["Run"];
type RunList = components["schemas"]["RunList"];
type StartRun = components["schemas"]["StartRun"];

shimReactFlow();

// user answers 2xx or 404: on 2xx orders runs, on 404 create_user does.
const branched: Definition = {
  nodes: [
    {
      id: "user",
      kind: "http",
      request: {
        method: "GET",
        url: "https://users.example.com/v1/users/{{ input.user_id }}",
      },
      outputs: [{ status: 404 }],
    },
    {
      id: "orders",
      kind: "http",
      request: { method: "GET", url: "https://orders.example.com/v1/orders" },
    },
    {
      id: "create_user",
      kind: "http",
      request: { method: "POST", url: "https://users.example.com/v1/users" },
    },
  ],
  edges: [
    { from: "user", to: "orders" },
    { from: "user", to: "create_user", on: 404 },
  ],
  sample_input: { user_id: "7" },
};

const at = (ms: number) =>
  new Date(Date.UTC(2026, 9, 30, 20, 0, 0, ms)).toISOString();

const started: Run = {
  id: "r-1",
  workflow_id: "wf-1",
  revision: 1,
  trigger: "editor",
  status: "running",
  started_at: at(0),
  input: { user_id: "7" },
};

// ended is the run as the server has it once it ended: user got 404, so
// create_user ran and orders didn't.
const ended: Run = {
  ...started,
  status: "succeeded",
  ended_at: at(300),
  output: { created: "10" },
  nodes: [
    {
      node: "user",
      status: "succeeded",
      attempts: 1,
      started_at: at(0),
      ended_at: at(82),
      request: {
        method: "GET",
        url: "https://users.example.com/v1/users/7",
        headers: { accept: "application/json" },
      },
      response: {
        status: 404,
        headers: { "content-type": "application/json" },
        body: { error: "not found" },
      },
    },
    { node: "orders", status: "skipped", attempts: 0, ended_at: at(82) },
    {
      node: "create_user",
      status: "succeeded",
      attempts: 1,
      started_at: at(90),
      ended_at: at(230),
      request: {
        method: "POST",
        url: "https://users.example.com/v1/users",
        headers: {},
      },
      response: { status: 201, headers: {}, body: { id: "10" } },
    },
  ],
};

const events: NodeEvent[] = [
  { node: "user", kind: "started", attempt: 1, at: at(0) },
  { node: "user", kind: "succeeded", attempt: 1, at: at(82), http_status: 404 },
  { node: "orders", kind: "skipped", attempt: 0, at: at(82) },
  { node: "create_user", kind: "started", attempt: 1, at: at(90) },
];

// stream answers with an event stream: each event, then the run's end.
function stream(nodes: NodeEvent[], run: Run) {
  const encoder = new TextEncoder();
  const text = [
    ...nodes.map(
      (e, i) => `event: node\nid: ${i + 1}\ndata: ${JSON.stringify(e)}\n\n`,
    ),
    `event: run\nid: end\ndata: ${JSON.stringify({ ...run, nodes: undefined })}\n\n`,
  ];
  return new HttpResponse(
    new ReadableStream({
      start(controller) {
        for (const t of text) controller.enqueue(encoder.encode(t));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

// serveRun answers a run's start, its events and the run itself, as the
// server does, and keeps what each start asked for.
function serveRun() {
  const asked: StartRun[] = [];
  let done = false;
  server.use(
    http.post<PathParams, StartRun, Run>(
      "/api/v1/workflows/wf-1/runs",
      async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json(started, { status: 202 });
      },
    ),
    http.get("/api/v1/runs/r-1/events", () => {
      done = true;
      return stream(events, ended);
    }),
    http.get("/api/v1/runs/r-1", () =>
      HttpResponse.json<Run>(done ? ended : started),
    ),
  );
  return asked;
}

async function run() {
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  const dialog = await screen.findByRole("dialog", { name: "Run" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
  return dialog;
}

// line is a step's second line on the canvas: what it calls, or, while a
// run is shown, how it went.
function line(step: string) {
  return within(screen.getByTestId(`rf__node-${step}`)).getAllByText(
    (_text, el) => el?.tagName === "SPAN" && el.className.includes("text-xs"),
  )[0]?.textContent;
}

test("Run starts the run with its input, and the canvas follows it to its end", async () => {
  renderEditor(branched);
  const asked = serveRun();
  const dialog = await (async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    return screen.findByRole("dialog", { name: "Run" });
  })();
  // The input starts as the sample input.
  expect(within(dialog).getByRole("textbox", { name: "Input" })).toHaveProperty(
    "value",
    '{\n  "user_id": "7"\n}',
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));

  expect(
    await screen.findByText(
      /^Run of revision 1, started .*: succeeded in 300 ms$/,
    ),
  ).toBeTruthy();
  expect(asked).toEqual([{ revision: 1, input: { user_id: "7" } }]);
  await waitFor(() => expect(line("user")).toBe("404, 82 ms"));
  expect(line("orders")).toBe("skipped");
  expect(line("create_user")).toBe("201, 140 ms");
  // The response user got is marked, and the line it didn't take dashed.
  expect(
    within(screen.getByTestId("rf__node-user")).getByText(
      ", the response it got",
    ).parentElement?.textContent,
  ).toBe("404, the response it got");
  expect(
    screen.getByTestId("rf__edge-user->orders").getAttribute("class"),
  ).toContain("untaken");
  expect(
    screen.getByTestId("rf__edge-user->create_user").getAttribute("class"),
  ).not.toContain("untaken");
  expect(screen.getByText("In this run: succeeded in 300 ms")).toBeTruthy();

  // Once the draft changes, the bar says the run was of what it was.
  fireEvent.click(screen.getByRole("button", { name: "Workflow settings" }));
  fireEvent.change(await screen.findByLabelText("Sample input"), {
    target: { value: '{"user_id": "8"}' },
  });
  expect(
    await screen.findByText(
      /: succeeded in 300 ms\. The draft has changed since\.$/,
    ),
  ).toBeTruthy();
});

test("a step's tabs say what it sent and got, and what it got can be kept as the sample", async () => {
  renderEditor(branched);
  serveRun();
  await run();
  await waitFor(() => expect(line("user")).toBe("404, 82 ms"));

  fireEvent.click(
    within(screen.getByTestId("rf__node-user")).getByText("user"),
  );
  const request = await screen.findByRole("tabpanel", { name: "Request" });
  expect(within(request).getByText("In this run: 404, 82 ms")).toBeTruthy();
  expect(
    within(request).getByText("GET https://users.example.com/v1/users/7"),
  ).toBeTruthy();

  // What it got shows in the tab of the response it was, and no other.
  fireEvent.click(screen.getByRole("tab", { name: "2xx" }));
  expect(
    within(screen.getByRole("tabpanel", { name: "2xx" })).queryByText(
      /^In this run it got/,
    ),
  ).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "404" }));
  const got = screen.getByRole("tabpanel", { name: "404" });
  expect(
    within(got).getByText("In this run it got 404, in 82 ms"),
  ).toBeTruthy();
  fireEvent.click(
    within(got).getByRole("button", { name: "Keep as the 404 sample" }),
  );
  expect(within(got).getByRole("textbox", { name: "404 body" })).toHaveProperty(
    "value",
    '{\n  "error": "not found"\n}',
  );
  expect(
    within(got).getByRole("textbox", { name: "404 headers" }),
  ).toHaveProperty("value", '{\n  "content-type": "application/json"\n}');
});

test("Runs lists the workflow's runs, picking one shows it, and Close run goes back to editing", async () => {
  renderEditor(branched);
  const served: Run = {
    ...started,
    id: "r-2",
    trigger: "served",
    status: "failed",
    ended_at: at(40),
    error: {
      code: "upstream_failed",
      detail: "user answered 503",
      node: "user",
    },
    nodes: [
      {
        node: "user",
        status: "failed",
        attempts: 1,
        started_at: at(0),
        ended_at: at(40),
        response: { status: 503, body: null },
        error: { code: "upstream_failed", detail: "user answered 503" },
      },
    ],
  };
  server.use(
    http.get("/api/v1/runs", ({ request }) => {
      expect(new URL(request.url).searchParams.get("workflow_id")).toBe("wf-1");
      return HttpResponse.json<RunList>({
        // A list has what a run is, and not what it read, made or did.
        runs: [
          {
            id: served.id,
            workflow_id: served.workflow_id,
            revision: served.revision,
            trigger: served.trigger,
            status: served.status,
            started_at: served.started_at,
            ended_at: at(40),
            error: served.error,
          },
        ],
      });
    }),
    http.get("/api/v1/runs/r-2", () => HttpResponse.json<Run>(served)),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
  const panel = await screen.findByRole("complementary", { name: "Runs" });
  fireEvent.click(
    await within(panel).findByRole("button", { name: /called at its URL/ }),
  );
  expect(
    await screen.findByText(
      /^Run of revision 1, started .*: failed in 40 ms: user answered 503$/,
    ),
  ).toBeTruthy();
  await waitFor(() => expect(line("user")).toBe("failed: 503"));

  fireEvent.click(screen.getByRole("button", { name: "Close run" }));
  await waitFor(() =>
    expect(line("user")).toBe(
      "GET https://users.example.com/v1/users/{{ input.user_id }}",
    ),
  );
  expect(screen.queryByText(/^Run of revision/)).toBeNull();
});

test("an input that doesn't match the input schema says why, under the input", async () => {
  renderEditor(branched);
  server.use(
    http.post("/api/v1/workflows/wf-1/runs", () =>
      HttpResponse.json<Problem>(
        {
          code: "invalid_input",
          detail: "The input doesn't match the workflow's input_schema.",
          errors: [
            { pointer: "/user_id", code: "type", detail: "expected string" },
          ],
        },
        { status: 400 },
      ),
    ),
  );
  const dialog = await run();
  expect(
    await within(dialog).findByText("/user_id: expected string"),
  ).toBeTruthy();
  expect(screen.queryByText(/^Run of revision/)).toBeNull();
});

test("Run saves unsaved changes first, and runs the revision saved", async () => {
  renderEditor(branched);
  const asked = serveRun();
  const saves: (string | null)[] = [];
  server.use(
    http.put<PathParams, Definition, Revision>(
      "/api/v1/workflows/wf-1/draft",
      async ({ request }) => {
        saves.push(request.headers.get("If-Match"));
        const { revision } = workflowRevision(
          "wf-1",
          "Spec example",
          await request.json(),
        );
        return HttpResponse.json<Revision>({ ...revision, revision: 2 });
      },
    ),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Workflow settings" }),
  );
  fireEvent.change(await screen.findByLabelText("Sample input"), {
    target: { value: '{"user_id": "8"}' },
  });
  await run();
  await waitFor(() => expect(asked).toHaveLength(1));
  expect(saves).toEqual(['"1"']);
  expect(asked[0]).toEqual({ revision: 2, input: { user_id: "8" } });
});
