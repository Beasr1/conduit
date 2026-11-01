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

shimReactFlow();

// user calls an API and answers 200; fallback could follow its failure, and
// 502 has no line yet.
const steps: Definition = {
  nodes: [
    {
      id: "user",
      kind: "http",
      request: { method: "GET", url: "https://users.example.com/v1/users" },
    },
    { id: "fallback", kind: "transform", expr: "nodes.user.error.code" },
  ],
  response: {
    answers: [{ status: 200, lines: [{ from: "user" }] }, { status: 502 }],
  },
};

// strip is a step's Unhandled, along the bottom of its card.
const strip = (step: string) =>
  screen
    .getByTestId(`rf__node-${step}`)
    .querySelector('[data-part="unhandled"]');

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

// saves keeps each draft the editor saves.
function saves(): Definition[] {
  const saved: Definition[] = [];
  server.use(
    http.put<PathParams, Definition, Revision>(
      "/api/v1/workflows/wf-1/draft",
      async ({ request }) => {
        const draft = await request.json();
        saved.push(draft);
        const { revision } = workflowRevision("wf-1", "Unhandled", draft);
        return HttpResponse.json<Revision>({ ...revision, revision: 2 });
      },
    ),
  );
  return saved;
}

test("every step has an Unhandled strip, not decided until it fails the run or a line leaves it", async () => {
  renderEditor(steps);
  const user = await screen.findByTestId("rf__node-user");
  expect(strip("user")?.textContent).toBe("Unhandled · not decided");
  expect(strip("fallback")?.textContent).toBe("Unhandled · not decided");
  expect(strip("user")?.hasAttribute("data-unjoined")).toBe(true);

  // A click on it opens its tab.
  fireEvent.click(within(user).getByText("Unhandled"));
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  expect(
    within(panel)
      .getByRole("tab", { name: "Unhandled" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  const fail = within(panel).getByRole("checkbox", { name: "Fail the run" });
  expect(fail.getAttribute("aria-checked")).toBe("false");

  // Connect Unhandled to joins a step on it, or an answer with no line.
  // Every answer, as an answer takes lines from any number of steps.
  expect(await options("Connect Unhandled to")).toEqual([
    "fallback",
    "Response 200",
    "Response 502",
  ]);
  // Down to the first, and Enter.
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "ArrowDown",
  });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter" });
  expect(await screen.findByTestId("rf__edge-user->fallback")).toBeTruthy();
  await waitFor(() => expect(strip("user")?.textContent).toBe("Unhandled"));
  expect(strip("user")?.hasAttribute("data-unjoined")).toBe(false);
  expect(
    within(panel).getByRole("button", {
      name: "Connection to fallback always",
    }),
  ).toBeTruthy();
  // The line takes its failures, so the run can't fail with them too.
  expect(fail.hasAttribute("data-disabled")).toBe(true);

  // What it takes, and how the steps after read it, it says when asked.
  fireEvent.click(
    within(panel).getByRole("button", { name: "About Unhandled" }),
  );
  expect(
    await screen.findByText(/^A status with no response, the connection/),
  ).toBeTruthy();
  expect(screen.getByText("nodes.user.error")).toBeTruthy();
});

test("a line from a step's response doesn't join its Unhandled", async () => {
  renderEditor({ ...steps, edges: [{ from: "user", to: "fallback" }] });
  await screen.findByTestId("rf__edge-user->fallback");
  expect(strip("user")?.textContent).toBe("Unhandled · not decided");
});

test("Fail the run decides what a step's failures do, and is saved so", async () => {
  renderEditor(steps);
  const saved = saves();
  fireEvent.click(
    within(await screen.findByTestId("rf__node-user")).getByText("Unhandled"),
  );
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  fireEvent.click(
    within(panel).getByRole("checkbox", { name: "Fail the run" }),
  );
  await waitFor(() =>
    expect(strip("user")?.textContent).toBe("Unhandled · fails the run"),
  );
  // The run stops there, so nothing follows it, and it gives no body.
  expect(
    within(panel).queryByRole("combobox", { name: "Connect Unhandled to" }),
  ).toBeNull();
  expect(
    within(panel).queryByRole("button", { name: "Write a body" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]?.nodes[0]?.unhandled).toEqual({ fail: true });
});

test("an Unhandled not decided marks its tab, and the list takes the cursor to Fail the run", async () => {
  renderEditor(steps, [
    { pointer: "/nodes/0/unhandled", code: "unhandled_undecided", detail: "" },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(
    within(list).getByRole("button", {
      name: "user · UnhandledJoin its Unhandled to a step or an answer, or let it fail the run.",
    }),
  );
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  expect(
    within(panel)
      .getByRole("tab", { name: "Unhandled (1 problem)" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  const fail = within(panel).getByRole("checkbox", { name: "Fail the run" });
  await waitFor(() => expect(document.activeElement).toBe(fail));
  expect(fail.getAttribute("aria-invalid")).toBe("true");
  // Deciding takes the problem away at once, before the next check answers,
  // which here it never does.
  server.use(http.post("/api/v1/validate", () => new Promise<never>(() => {})));
  fireEvent.click(fail);
  await waitFor(() =>
    expect(within(panel).queryByText(/^Join its Unhandled/)).toBeNull(),
  );
});

test("one saved both failing the run and with a line can still be unchecked", async () => {
  renderEditor(
    {
      ...steps,
      nodes: steps.nodes.map((n) =>
        n.id === "user" ? { ...n, unhandled: { fail: true } } : n,
      ),
      edges: [{ from: "user", to: "fallback", unhandled: true }],
    },
    [
      {
        pointer: "/nodes/0/unhandled/fail",
        code: "unhandled_both",
        detail: "",
      },
    ],
  );
  fireEvent.click(
    within(await screen.findByTestId("rf__node-user")).getByText("Unhandled"),
  );
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  expect(
    within(panel).getByText(
      "Its Unhandled has a line and fails the run: keep one.",
    ),
  ).toBeTruthy();
  const fail = within(panel).getByRole("checkbox", { name: "Fail the run" });
  expect(fail.hasAttribute("data-disabled")).toBe(false);
  fireEvent.click(fail);
  // Its line shows once it doesn't fail the run.
  expect(
    await within(panel).findByRole("button", {
      name: "Connection to fallback always",
    }),
  ).toBeTruthy();
  expect(fail.hasAttribute("data-disabled")).toBe(true);
});

test("Unhandled joined straight to an answer is saved so", async () => {
  renderEditor(steps);
  const saved = saves();
  fireEvent.click(
    within(await screen.findByTestId("rf__node-user")).getByText("Unhandled"),
  );
  await screen.findByRole("complementary", { name: "HTTP step" });
  await choose("Connect Unhandled to", "Response 502");
  expect(await screen.findByTestId("rf__edge-user->#response:1")).toBeTruthy();
  // 502 offers itself no more, as this block's line is in it.
  expect(await options("Connect Unhandled to")).toEqual([
    "fallback",
    "Response 200",
  ]);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]?.response?.answers).toEqual([
    { status: 200, lines: [{ from: "user" }] },
    { status: 502, lines: [{ from: "user", unhandled: true }] },
  ]);
});

test("a transform's panel has its Unhandled, and joining it to an answer adds no case", async () => {
  renderEditor({
    ...steps,
    response: {
      answers: [
        { status: 200, lines: [{ from: "fallback" }] },
        { status: 500 },
      ],
    },
  });
  fireEvent.click(await screen.findByText("fallback"));
  const panel = await screen.findByRole("complementary", {
    name: "Transform step",
  });
  expect(
    within(panel).getByRole("heading", { name: "When it fails" }),
  ).toBeTruthy();
  await choose("Connect Unhandled to", "Response 500");
  await waitFor(() => expect(strip("fallback")?.textContent).toBe("Unhandled"));
  // A failure picks no answer, so it's still an expression.
  expect(
    within(panel).getByRole("textbox", { name: "Expression" }),
  ).toBeTruthy();
});

test("a click on a transform's strip brings its Unhandled into view", async () => {
  // jsdom draws nothing, so it has no scrollIntoView to call: this stands in.
  const proto = Element.prototype as {
    scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
  };
  const before = proto.scrollIntoView;
  const scrolled: (string | null)[] = [];
  proto.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute("aria-labelledby"));
  };
  try {
    renderEditor(steps);
    fireEvent.click(
      within(await screen.findByTestId("rf__node-fallback")).getByText(
        "Unhandled",
      ),
    );
    await screen.findByRole("complementary", { name: "Transform step" });
    await waitFor(() => expect(scrolled).toContain("step-unhandled-1"));
  } finally {
    proto.scrollIntoView = before;
  }
});

test("Unhandled's own body: written, previewed over a failure made up, and taken away", async () => {
  renderEditor(steps);
  server.use(
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: null, nodes: {} },
        skipped: false,
        problems: [],
        unhandled: {
          reads: {
            input: null,
            nodes: {
              user: {
                error: { code: "upstream_failed", detail: "user failed" },
              },
            },
          },
          gives: { error: "user failed" },
        },
      }),
    ),
  );
  fireEvent.click(
    within(await screen.findByTestId("rf__node-user")).getByText("Unhandled"),
  );
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  fireEvent.click(within(panel).getByRole("button", { name: "Write a body" }));
  const body = await within(panel).findByRole("textbox", {
    name: "Unhandled body",
  });
  expect(body).toHaveProperty("value", "{ 'error': nodes.user.error.detail }");
  // It reads the step's failure, made up, and says what it gives.
  expect(
    await within(panel).findByRole("button", {
      name: "Insert nodes.user.error.code",
    }),
  ).toBeTruthy();
  expect(within(panel).getByText(/"error": "user failed"/)).toBeTruthy();
  fireEvent.click(
    within(panel).getByRole("button", { name: "Remove the body" }),
  );
  expect(
    await within(panel).findByRole("button", { name: "Write a body" }),
  ).toBeTruthy();
});

test("Unhandled's body joined straight to an answer warns when it sends what the run read", async () => {
  renderEditor({
    ...steps,
    nodes: steps.nodes.map((n) =>
      n.id === "user" ? { ...n, unhandled: { body: "$$" } } : n,
    ),
    response: {
      answers: [
        { status: 200, lines: [{ from: "user" }] },
        { status: 502, lines: [{ from: "user", unhandled: true }] },
      ],
    },
  });
  fireEvent.click(
    within(await screen.findByTestId("rf__node-user")).getByText("Unhandled"),
  );
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  await within(panel).findByRole("textbox", { name: "Unhandled body" });
  expect(
    within(panel).getByText(/^This sends callers what the run read/),
  ).toBeTruthy();
});

test("a problem in Unhandled's body marks its tab and shows under it", async () => {
  renderEditor(
    {
      ...steps,
      nodes: steps.nodes.map((n) =>
        n.id === "user" ? { ...n, unhandled: { body: "" } } : n,
      ),
    },
    [{ pointer: "/nodes/0/unhandled/body", code: "required", detail: "" }],
  );
  fireEvent.click(await screen.findByText("user"));
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  const tab = within(panel).getByRole("tab", { name: /^Unhandled/ });
  expect(tab.textContent).toBe("Unhandled (1 problem)");
  fireEvent.click(tab);
  expect(
    await within(panel).findByText("Write its body, or remove it."),
  ).toBeTruthy();
});

test("a body that sends the run is warned about only once Unhandled answers", async () => {
  renderEditor({
    ...steps,
    nodes: steps.nodes.map((n) =>
      n.id === "user" ? { ...n, unhandled: { body: "$$" } } : n,
    ),
  });
  fireEvent.click(
    within(await screen.findByTestId("rf__node-user")).getByText("Unhandled"),
  );
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  await within(panel).findByRole("textbox", { name: "Unhandled body" });
  // Until then, only the steps after it read what it gives.
  expect(within(panel).queryByText(/^This sends callers/)).toBeNull();
});
