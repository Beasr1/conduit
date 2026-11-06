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
// it took its line to create_user, which ran, and orders didn't.
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
      took: [{ to: "create_user", on: 404 }],
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
  {
    node: "user",
    kind: "succeeded",
    attempt: 1,
    at: at(82),
    http_status: 404,
    took: [{ to: "create_user", on: 404 }],
  },
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

// serveRun answers a run's start, its events, nodes, and the run itself,
// ending as end, as the server does, and keeps what each start asked for.
function serveRun(end: Run = ended, nodes: NodeEvent[] = events) {
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
      return stream(nodes, end);
    }),
    http.get("/api/v1/runs/r-1", () =>
      HttpResponse.json<Run>(done ? end : started),
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

test("the response card marks the answer the run gave, and its panel shows it", async () => {
  renderEditor({
    ...branched,
    response: { answers: [{ status: 201, lines: [{ from: "create_user" }] }] },
  });
  serveRun({ ...ended, answered: 201, output: { id: "10" } });
  await run();
  expect(
    await screen.findByText(
      /^Run of revision 1, started .*: succeeded in 300 ms, answered 201$/,
    ),
  ).toBeTruthy();
  const card = screen.getByTestId("rf__node-#response");
  await waitFor(() =>
    expect(
      within(card).getByText(", the answer it gave").parentElement?.textContent,
    ).toBe("201, the answer it gave"),
  );
  expect(
    screen
      .getByTestId("rf__edge-create_user->#response:0")
      .getAttribute("class"),
  ).not.toContain("untaken");

  fireEvent.click(within(card).getByText("Response"));
  const panel = await screen.findByRole("complementary", { name: "Response" });
  expect(
    within(panel).getByText("In this run: succeeded in 300 ms, answered 201"),
  ).toBeTruthy();
  expect(within(panel).getByText(/"id": "10"/)).toBeTruthy();
});

test("a line into the response that a run didn't reach is dashed", async () => {
  renderEditor({
    ...branched,
    response: { answers: [{ status: 200, lines: [{ from: "orders" }] }] },
  });
  serveRun({
    ...ended,
    status: "failed",
    error: { code: "workflow_error", detail: "no answer: orders was skipped" },
  });
  await run();
  expect(
    await screen.findByText(
      /^Run of revision 1, started .*: failed in 300 ms: no answer: orders was skipped$/,
    ),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.getByTestId("rf__edge-orders->#response:0").getAttribute("class"),
    ).toContain("untaken"),
  );
});

test("of two answers a step gives, the line into the one the run didn't give is dashed", async () => {
  renderEditor({
    ...branched,
    response: {
      answers: [
        { status: 200, lines: [{ from: "create_user" }] },
        { status: 201, lines: [{ from: "create_user" }] },
      ],
    },
  });
  serveRun({ ...ended, answered: 201, output: { id: "10" } });
  await run();
  expect(
    await screen.findByText(
      /^Run of revision 1, started .*: succeeded in 300 ms, answered 201$/,
    ),
  ).toBeTruthy();
  const line = (k: number) =>
    screen
      .getByTestId(`rf__edge-create_user->#response:${k}`)
      .getAttribute("class") ?? "";
  await waitFor(() => expect(line(0)).toContain("untaken"));
  expect(line(1)).not.toContain("untaken");
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

// A step that uses an upstream says what a run sent under its Parameters,
// as it has no Request; and its samples are the upstream's, changed on its
// page, so what it got isn't kept as one here (plan 07).
test("a step that uses an upstream says what a run sent under its Parameters, and keeps no sample", async () => {
  const [user, ...rest] = branched.nodes;
  const users = {
    parameters: [{ name: "user_id" }],
    request: {
      method: "GET" as const,
      url: "https://users.example.com/v1/users/{{ user_id }}",
    },
    outputs: user?.outputs,
  };
  const v1 = {
    upstream: {
      id: "u-1",
      name: "Users API",
      latest_version: 1,
      created_at: at(0),
    },
    version: 1,
    definition: users,
    provenance: { actor: "token" },
    created_at: at(0),
  };
  server.use(
    http.get("/api/v1/upstreams/u-1", () => HttpResponse.json(v1)),
    http.get("/api/v1/upstreams/u-1/versions/1", () => HttpResponse.json(v1)),
  );
  renderEditor(
    {
      ...branched,
      nodes: [
        {
          id: "user",
          kind: "http",
          uses: { upstream: "u-1", version: 1 },
          with: { user_id: "input.user_id" },
        },
        ...rest,
      ],
    },
    [],
    { "u-1@1": users },
  );
  serveRun();
  await run();
  await waitFor(() => expect(line("user")).toBe("404, 82 ms"));
  fireEvent.click(
    within(screen.getByTestId("rf__node-user")).getByText("user"),
  );
  expect(
    within(
      await screen.findByRole("tabpanel", { name: "Parameters" }),
    ).getByText("In this run: 404, 82 ms"),
  ).toBeTruthy();
  fireEvent.click(await screen.findByRole("tab", { name: "404" }));
  const got = screen.getByRole("tabpanel", { name: "404" });
  expect(
    within(got).getByText("In this run it got 404, in 82 ms"),
  ).toBeTruthy();
  expect(
    within(got).queryByRole("button", { name: "Keep as the 404 sample" }),
  ).toBeNull();
  expect(
    within(got).getByText(
      "Its samples are the upstream's: change them on its page.",
    ),
  ).toBeTruthy();
});

test("Runs lists the workflow's runs, picking one shows it, and Close run goes back to editing", async () => {
  renderEditor(branched);
  const served: Run = {
    ...started,
    id: "r-2",
    trigger: "served",
    key: { id: "k-1", name: "CRM sync", prefix: "cnd_7f3a" },
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
            key: served.key,
            trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
            status: served.status,
            started_at: served.started_at,
            ended_at: at(40),
            error: served.error,
          },
          // From before served runs kept their key.
          {
            id: "r-1",
            workflow_id: served.workflow_id,
            revision: 1,
            trigger: "served",
            status: "succeeded",
            started_at: at(-500),
            ended_at: at(-400),
          },
          // From before runs kept their trace.
          {
            id: "r-0",
            workflow_id: served.workflow_id,
            revision: 1,
            trigger: "editor",
            status: "succeeded",
            started_at: at(-1000),
            ended_at: at(-900),
          },
        ],
      });
    }),
    http.get("/api/v1/runs/r-2", () => HttpResponse.json<Run>(served)),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
  const panel = await screen.findByRole("complementary", { name: "Runs" });
  // Its trace, which runs calling each other share (plan 06); a run from
  // before traces were kept has none.
  expect(
    await within(panel).findByText("trace 4bf92f3577b34da6a3ce929d0e0e4736"),
  ).toBeTruthy();
  expect(within(panel).getAllByText(/^trace/)).toHaveLength(1);
  expect(
    within(panel).getByRole("button", { name: /called at its URL/ }),
  ).toBeTruthy();
  expect(within(panel).getByRole("button", { name: /run here/ })).toBeTruthy();
  fireEvent.click(
    within(panel).getByRole("button", {
      name: /called by CRM sync \(cnd_7f3a…\)/,
    }),
  );
  expect(
    await screen.findByText(
      /^Run of revision 1, called by CRM sync \(cnd_7f3a…\), started .*: failed in 40 ms: user answered 503$/,
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

// caughtDef has fallback after user's Unhandled.
const caughtDef: Definition = {
  ...branched,
  nodes: [
    ...branched.nodes,
    { id: "fallback", kind: "transform", expr: "nodes.user.error.code" },
  ],
  edges: [
    ...(branched.edges ?? []),
    { from: "user", to: "fallback", unhandled: true },
  ],
};

const userFailed = {
  code: "upstream_failed" as const,
  detail: "GET https://users.example.com/v1/users/7: status 500",
  caught: true,
};

// caught is the run once user's 500 went to its Unhandled: fallback ran,
// and neither step after user's responses did.
const caught: Run = {
  ...ended,
  output: "upstream_failed",
  nodes: [
    {
      node: "user",
      status: "failed",
      attempts: 1,
      started_at: at(0),
      ended_at: at(82),
      response: { status: 500, headers: {}, body: { error: "down" } },
      error: userFailed,
      took: [{ to: "fallback", unhandled: true }],
    },
    { node: "orders", status: "skipped", attempts: 0, ended_at: at(82) },
    { node: "create_user", status: "skipped", attempts: 0, ended_at: at(82) },
    {
      node: "fallback",
      status: "succeeded",
      attempts: 0,
      started_at: at(90),
      ended_at: at(91),
      response: { body: "upstream_failed" },
    },
  ],
};

test("a step whose Unhandled took its failure is marked so, and the run goes on down its line", async () => {
  renderEditor(caughtDef);
  serveRun(caught, [
    { node: "user", kind: "started", attempt: 1, at: at(0) },
    {
      node: "user",
      kind: "failed",
      attempt: 1,
      at: at(82),
      http_status: 500,
      error: userFailed,
      took: [{ to: "fallback", unhandled: true }],
    },
  ]);
  await run();
  await waitFor(() => expect(line("user")).toBe("Unhandled: 500"));
  // Once the run is recorded, fallback has ended too.
  await waitFor(() => expect(line("fallback")).toBe("done, 1 ms"));
  expect(
    within(screen.getByTestId("rf__node-user")).getByText(
      ", the block its failure took",
    ).parentElement?.textContent,
  ).toBe("Unhandled, the block its failure took");
  // Its responses' lines weren't taken; its Unhandled's was.
  const kind = (id: string) =>
    screen.getByTestId(`rf__edge-${id}`).getAttribute("class") ?? "";
  expect(kind("user->orders")).toContain("untaken");
  expect(kind("user->create_user")).toContain("untaken");
  expect(kind("user->fallback")).not.toContain("untaken");
});

// A line from a step's Unhandled into an answer is drawn only while picked,
// or while a run shown answered through it, as a line it took: solid.
test("a run that answered with a step's failure draws that line", async () => {
  renderEditor({
    ...branched,
    response: {
      answers: [
        { status: 502, lines: [{ from: "user", unhandled: true }] },
        { status: 200, lines: [{ from: "orders" }] },
      ],
    },
  });
  const link = () => screen.queryByTestId("rf__edge-user->#response:0");
  await screen.findByTestId("rf__edge-orders->#response:1");
  expect(link()).toBeNull();
  serveRun({ ...caught, answered: 502, nodes: caught.nodes?.slice(0, 3) }, [
    { node: "user", kind: "started", attempt: 1, at: at(0) },
    {
      node: "user",
      kind: "failed",
      attempt: 1,
      at: at(82),
      http_status: 500,
      error: userFailed,
    },
  ]);
  await run();
  await waitFor(() => expect(link()).toBeTruthy());
  expect(link()?.getAttribute("class")).not.toContain("link");
});

test("a run that failed, answered by the response's Unhandled, marks that and no answer", async () => {
  renderEditor({
    ...branched,
    response: {
      answers: [{ status: 502, lines: [{ from: "create_user" }] }],
      errors: { body: "{ 'error': error.code }" },
    },
  });
  serveRun({
    ...ended,
    status: "failed",
    answered: 502,
    output: { error: "upstream_failed" },
    error: { code: "upstream_failed", detail: "status 500", node: "user" },
  });
  await run();
  expect(
    await screen.findByText(
      /^Run of revision 1, started .*: failed in 300 ms: status 500; Unhandled answered 502$/,
    ),
  ).toBeTruthy();
  const card = screen.getByTestId("rf__node-#response");
  // Its strip, not the 502 answer the run didn't give.
  await waitFor(() =>
    expect(
      within(card).getByText(", the answer it gave").parentElement?.textContent,
    ).toBe("Unhandled · your error body, the answer it gave"),
  );
  // create_user answered on the line into 502, but the run failed: it
  // took no answer's line.
  expect(
    screen
      .getByTestId("rf__edge-create_user->#response:0")
      .getAttribute("class"),
  ).toContain("untaken");
});

test("a step's Unhandled tab says what it took in the run, and what its body gave", async () => {
  renderEditor({
    ...caughtDef,
    nodes: caughtDef.nodes.map((n) =>
      n.id === "user" ? { ...n, unhandled: { body: "{ 'down': true }" } } : n,
    ),
  });
  serveRun(
    {
      ...caught,
      nodes: caught.nodes?.map((n) =>
        n.node === "user"
          ? {
              ...n,
              response: {
                ...n.response,
                body: { error: "down" },
                gave: { down: true },
              },
            }
          : n,
      ),
    },
    [
      { node: "user", kind: "started", attempt: 1, at: at(0) },
      {
        node: "user",
        kind: "failed",
        attempt: 1,
        at: at(82),
        http_status: 500,
        error: userFailed,
      },
    ],
  );
  await run();
  await waitFor(() => expect(line("user")).toBe("Unhandled: 500"));
  fireEvent.click(
    within(screen.getByTestId("rf__node-user")).getByText("Unhandled"),
  );
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  const inRun = await within(panel).findByRole("heading", {
    name: "In this run: Unhandled: 500",
  });
  const section = inRun.parentElement;
  if (!section) throw new Error("no section");
  expect(within(section).getByText(userFailed.detail)).toBeTruthy();
  expect(within(section).getByText("It got 500")).toBeTruthy();
  expect(within(section).getByText(/"error": "down"/)).toBeTruthy();
  expect(within(section).getByText("Its Unhandled body gave")).toBeTruthy();
  expect(within(section).getByText(/"down": true/)).toBeTruthy();
});

test("a step that failed with no line from its Unhandled shows nothing in that tab", async () => {
  renderEditor(caughtDef);
  serveRun({
    ...caught,
    status: "failed",
    error: { ...userFailed, caught: undefined, node: "user" },
    nodes: caught.nodes?.map((n) =>
      n.node === "user"
        ? { ...n, error: { code: userFailed.code, detail: userFailed.detail } }
        : n,
    ),
  });
  await run();
  await waitFor(() => expect(line("user")).toBe("failed: 500"));
  fireEvent.click(
    within(screen.getByTestId("rf__node-user")).getByText("Unhandled"),
  );
  await screen.findByRole("complementary", { name: "HTTP step" });
  expect(
    within(screen.getByRole("tabpanel")).queryByRole("heading", {
      name: /^In this run/,
    }),
  ).toBeNull();
});

test("a transform whose Unhandled took its failure gave nothing of its own", async () => {
  renderEditor({
    nodes: [
      {
        id: "count",
        kind: "transform",
        expr: "$number(input.n)",
        unhandled: { body: "0" },
      },
      { id: "next", kind: "transform", expr: "nodes.count.body + 1" },
    ],
    edges: [{ from: "count", to: "next", unhandled: true }],
  });
  const failed = {
    code: "workflow_error" as const,
    detail: "expr: not a number",
    caught: true,
  };
  serveRun(
    {
      ...ended,
      output: 1,
      nodes: [
        {
          node: "count",
          status: "failed",
          attempts: 0,
          started_at: at(0),
          ended_at: at(1),
          response: { body: null, gave: 0 },
          error: failed,
        },
        {
          node: "next",
          status: "succeeded",
          attempts: 0,
          started_at: at(2),
          ended_at: at(3),
          response: { body: 1 },
        },
      ],
    },
    [
      { node: "count", kind: "started", attempt: 0, at: at(0) },
      { node: "count", kind: "failed", attempt: 0, at: at(1), error: failed },
    ],
  );
  await run();
  await waitFor(() => expect(line("count")).toBe("Unhandled: workflow error"));
  fireEvent.click(screen.getByText("count"));
  const panel = await screen.findByRole("complementary", {
    name: "Transform step",
  });
  await within(panel).findByText("Its Unhandled body gave");
  expect(within(panel).queryByText("It gave")).toBeNull();
});
