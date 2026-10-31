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
  response: { answers: [{ status: 200, from: "user" }, { status: 502 }] },
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

test("every step has an Unhandled strip, which fails the run until a line leaves it", async () => {
  renderEditor(steps);
  const user = await screen.findByTestId("rf__node-user");
  expect(strip("user")?.textContent).toBe("Unhandled · fails the run");
  expect(strip("fallback")?.textContent).toBe("Unhandled · fails the run");
  expect(strip("user")?.hasAttribute("data-unjoined")).toBe(true);

  // A click on it opens its tab, which says what it takes.
  fireEvent.click(within(user).getByText("Unhandled"));
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  expect(
    within(panel)
      .getByRole("tab", { name: "Unhandled" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    within(panel).getByText(/^It takes what the step's responses don't/),
  ).toBeTruthy();
  expect(
    within(panel).getByText("nodes.user.error").parentElement?.textContent,
  ).toBe(
    "The steps after read the failure as nodes.user.error, { code, detail }, beside status, headers and body when the upstream answered.",
  );

  // Connect Unhandled to joins a step on it, or an answer with no line.
  expect(await options("Connect Unhandled to")).toEqual([
    "fallback",
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
});

test("a line from a step's response doesn't join its Unhandled", async () => {
  renderEditor({ ...steps, edges: [{ from: "user", to: "fallback" }] });
  await screen.findByTestId("rf__edge-user->fallback");
  expect(strip("user")?.textContent).toBe("Unhandled · fails the run");
});

test("Unhandled joined straight to an answer is saved so, and warns what callers get", async () => {
  renderEditor(steps);
  const saved = saves();
  fireEvent.click(
    within(await screen.findByTestId("rf__node-user")).getByText("Unhandled"),
  );
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  expect(within(panel).queryByText(/^Callers get whatever/)).toBeNull();
  await choose("Connect Unhandled to", "Response 502");
  expect(
    await within(panel).findByText(/^Callers get whatever the upstream sent/),
  ).toBeTruthy();
  expect(await screen.findByTestId("rf__edge-user->#response:1")).toBeTruthy();
  // 502 offers itself no more, as it has its line.
  expect(await options("Connect Unhandled to")).toEqual(["fallback"]);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]?.response?.answers).toEqual([
    { status: 200, from: "user" },
    { status: 502, from: "user", unhandled: true },
  ]);
});

test("a transform's panel has its Unhandled, and joining it to an answer adds no case", async () => {
  renderEditor({
    ...steps,
    response: {
      answers: [{ status: 200, from: "fallback" }, { status: 500 }],
    },
  });
  fireEvent.click(await screen.findByText("fallback"));
  const panel = await screen.findByRole("complementary", {
    name: "Transform step",
  });
  expect(
    within(panel).getByText(/^It takes the step's JSONata failing/),
  ).toBeTruthy();
  await choose("Connect Unhandled to", "Response 500");
  await waitFor(() => expect(strip("fallback")?.textContent).toBe("Unhandled"));
  // A failure picks no answer, so it's still an expression, and a
  // transform's failure sends no upstream's body to warn about.
  expect(
    within(panel).getByRole("textbox", { name: "Expression" }),
  ).toBeTruthy();
  expect(within(panel).queryByText(/^Callers get whatever/)).toBeNull();
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
  fireEvent.click(
    within(panel).getByRole("button", { name: "Write your own" }),
  );
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
    within(panel).getByRole("button", {
      name: "Give what the step got instead",
    }),
  );
  expect(
    await within(panel).findByRole("button", { name: "Write your own" }),
  ).toBeTruthy();
});

test("with a body, Unhandled joined straight to an answer sends that, not what the upstream sent", async () => {
  renderEditor({
    ...steps,
    nodes: steps.nodes.map((n) =>
      n.id === "user" ? { ...n, unhandled: { body: "$$" } } : n,
    ),
    response: {
      answers: [
        { status: 200, from: "user" },
        { status: 502, from: "user", unhandled: true },
      ],
    },
  });
  fireEvent.click(
    within(await screen.findByTestId("rf__node-user")).getByText("Unhandled"),
  );
  const panel = await screen.findByRole("complementary", { name: "HTTP step" });
  await within(panel).findByRole("textbox", { name: "Unhandled body" });
  expect(within(panel).queryByText(/^Callers get whatever/)).toBeNull();
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
    await within(panel).findByText(
      "Write its body, or give what the step got instead.",
    ),
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
