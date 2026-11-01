import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { specExample, workflowRevision } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type Revision = components["schemas"]["Revision"];

shimReactFlow();

// user answers 2xx or 404: found gives 200, gone gives 404, and 409 has no
// line yet.
const answering: Definition = {
  ...specExample,
  nodes: [
    ...specExample.nodes.map((n) =>
      n.id === "user" ? { ...n, outputs: [{ status: 404 }] } : n,
    ),
    { id: "found", kind: "transform", expr: "nodes.user.body" },
    { id: "gone", kind: "transform", expr: "{ 'error': 'no such user' }" },
  ],
  edges: [
    ...(specExample.edges ?? []),
    { from: "user", to: "found" },
    { from: "user", to: "gone", on: 404 },
  ],
  response: {
    answers: [
      { status: 200, from: "found" },
      { status: 404, from: "gone", schema: { type: "object" } },
      { status: 409 },
    ],
  },
};

const card = () => screen.getByTestId("rf__node-#response");

// blocks are the card's answers, then + Add, as the canvas draws them.
function blocks() {
  return [
    ...card().querySelectorAll('[data-part]:not([data-part="unhandled"])'),
  ].map((b) => b.textContent);
}

// strip is the card's Unhandled, along its bottom.
const strip = () => card().querySelector('[data-part="unhandled"]');

async function openResponse() {
  fireEvent.click(
    within(await screen.findByTestId("rf__node-#response")).getByText(
      "Response",
    ),
  );
  return screen.findByRole("complementary", { name: "Response" });
}

async function close() {
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
}

// options opens a select from the keyboard, as a screen reader would, and
// gives what it offers.
async function options(label: string) {
  const select = screen.getByRole("combobox", { name: label });
  select.focus();
  fireEvent.keyDown(select, { key: "ArrowDown" });
  return (await screen.findAllByRole("option")).map((o) => o.textContent);
}

test("the card lists each answer with its point, and the panel the step that gives it", async () => {
  renderEditor(answering);
  expect(await screen.findByText("From found, gone")).toBeTruthy();
  expect(blocks()).toEqual(["200", "404", "409", "+ Add"]);
  expect(within(card()).getByText("also 4xx · 5xx")).toBeTruthy();
  expect(screen.getByTestId("rf__edge-found->#response:0")).toBeTruthy();
  expect(screen.getByTestId("rf__edge-gone->#response:1")).toBeTruthy();
  // An answer no line reaches yet is dimmed.
  expect(
    card().querySelector('[data-part="409"]')?.hasAttribute("data-unjoined"),
  ).toBe(true);

  const panel = await openResponse();
  expect(
    within(panel).getByRole("button", { name: "Given by gone" }),
  ).toBeTruthy();
  expect(within(panel).getByText(/^No line yet/)).toBeTruthy();
  for (const status of ["400", "401", "404", "500", "502", "503", "504"])
    expect(within(panel).getByText(status, { selector: "dt" })).toBeTruthy();
  fireEvent.click(
    within(panel).getByRole("button", { name: "Given by found" }),
  );
  expect(
    await screen.findByRole("complementary", { name: "Transform step" }),
  ).toBeTruthy();
});

test("an HTTP step that gives an answer opens on the response its line leaves on", async () => {
  renderEditor({
    ...specExample,
    nodes: specExample.nodes.map((n) =>
      n.id === "crm" ? { ...n, outputs: [{ status: 409 }] } : n,
    ),
    response: { answers: [{ status: 409, from: "crm", on: 409 }] },
  });
  const panel = await openResponse();
  fireEvent.click(
    within(panel).getByRole("button", { name: "Given by crm on 409" }),
  );
  const step = await screen.findByRole("complementary", { name: "HTTP step" });
  expect(
    within(step)
      .getByRole("tab", { name: "409" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

test("answers are added, given a schema and removed in the response's panel", async () => {
  renderEditor(answering);
  let panel = await openResponse();
  expect(
    within(panel).getByRole("textbox", { name: "404 schema" }),
  ).toHaveProperty("value", '{\n  "type": "object"\n}');

  const add = within(panel).getByRole("textbox", { name: "Add an answer" });
  fireEvent.change(add, { target: { value: "199" } });
  expect(
    within(panel).getByText("A whole number from 200 to 599."),
  ).toBeTruthy();
  fireEvent.change(add, { target: { value: "404" } });
  expect(within(panel).getByText("It has that answer already.")).toBeTruthy();
  fireEvent.change(add, { target: { value: "500" } });
  fireEvent.click(within(panel).getByRole("button", { name: "Add" }));
  expect(blocks()).toEqual(["200", "404", "409", "500", "+ Add"]);

  fireEvent.change(within(panel).getByRole("textbox", { name: "500 schema" }), {
    target: { value: '{"type": "string"}' },
  });
  fireEvent.click(
    within(panel).getByRole("button", { name: "Remove the 404 answer" }),
  );
  await waitFor(() => expect(blocks()).toEqual(["200", "409", "500", "+ Add"]));
  // What was typed stays with its answer, and the draft has it.
  expect(
    within(panel).getByRole("textbox", { name: "500 schema" }),
  ).toHaveProperty("value", '{"type": "string"}');
  await close();
  panel = await openResponse();
  expect(
    within(panel).getByRole("textbox", { name: "500 schema" }),
  ).toHaveProperty("value", '{\n  "type": "string"\n}');
});

test("+ Add on the card opens the response at Add an answer", async () => {
  renderEditor(answering);
  fireEvent.click(
    within(await screen.findByTestId("rf__node-#response")).getByText("+ Add"),
  );
  const panel = await screen.findByRole("complementary", { name: "Response" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(panel).getByRole("textbox", { name: "Add an answer" }),
    ),
  );
});

test("a step joins an answer with Connect to, and leaves it with Disconnect", async () => {
  renderEditor({ ...specExample, response: { answers: [{ status: 200 }] } });
  expect(await screen.findByText("Nothing answers yet")).toBeTruthy();

  fireEvent.click(screen.getByText("crm"));
  fireEvent.click(await screen.findByRole("tab", { name: "2xx" }));
  // crm can't go back to the steps before it, but it can give 200.
  expect(await options("Connect to")).toEqual(["Response 200"]);
  fireEvent.click(screen.getByRole("option", { name: "Response 200" }));
  expect(await screen.findByTestId("rf__edge-crm->#response:0")).toBeTruthy();
  expect(within(card()).getByText("From crm")).toBeTruthy();
  // It's what follows crm's 2xx now, and 200's only line.
  expect(screen.getByRole("combobox", { name: "Connect to" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Response 200: this step answers" }),
  );

  const panel = await screen.findByRole("complementary", { name: "Response" });
  fireEvent.click(
    within(panel).getByRole("button", { name: "Disconnect crm from 200" }),
  );
  expect(await within(card()).findByText("Nothing answers yet")).toBeTruthy();
  expect(screen.queryByTestId("rf__edge-crm->#response:0")).toBeNull();
  expect(blocks()).toEqual(["200", "+ Add"]);
});

test("a transform joined to a second answer picks between them with cases", async () => {
  renderEditor({
    nodes: [{ id: "respond", kind: "transform", expr: "{ 'id': 7 }" }],
    response: {
      answers: [{ status: 200, from: "respond" }, { status: 404 }],
    },
  });
  fireEvent.click(await screen.findByText("respond"));
  await screen.findByRole("complementary", { name: "Transform step" });
  expect(await options("Connect to")).toEqual(["Response 404"]);
  fireEvent.click(screen.getByRole("option", { name: "Response 404" }));
  // Its expression is the first case's body now, exiting with 200, and a
  // second exits with 404; each answer's line leaves the exit of its status.
  expect(
    await screen.findByRole("textbox", { name: "Case 1 body" }),
  ).toHaveProperty("value", "{ 'id': 7 }");
  expect(screen.getByRole("textbox", { name: "Case 1 status" })).toHaveProperty(
    "value",
    "200",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Case 2" }));
  expect(screen.getByRole("textbox", { name: "Case 2 status" })).toHaveProperty(
    "value",
    "404",
  );
  expect(screen.getByTestId("rf__edge-respond->#response:1")).toBeTruthy();
  const exits = [
    ...screen
      .getByTestId("rf__node-respond")
      .querySelectorAll("[data-part^=case]"),
  ].map((b) => b.textContent);
  expect(exits).toEqual(["Case 1 · 200", "Case 2 · 404"]);
});

test("an expression that sends the run is warned about once its step answers", async () => {
  renderEditor({
    nodes: [{ id: "respond", kind: "transform", expr: "$$" }],
    response: { answers: [{ status: 200 }] },
  });
  fireEvent.click(await screen.findByText("respond"));
  const panel = await screen.findByRole("complementary", {
    name: "Transform step",
  });
  // Until then, only the steps after it read its value.
  expect(within(panel).queryByText(/^This sends callers/)).toBeNull();
  expect(await options("Connect to")).toEqual(["Response 200"]);
  fireEvent.click(screen.getByRole("option", { name: "Response 200" }));
  expect(await within(panel).findByText(/^This sends callers/)).toBeTruthy();
});

test("a problem in an answer marks the card and shows under the answer", async () => {
  renderEditor(answering, [
    {
      pointer: "/response/answers/1/from",
      code: "overlap",
      detail:
        "200 (found) and 404 (gone) can both be reached in one run: join both to one transform, which picks the answer",
    },
  ]);
  expect(
    await within(await screen.findByTestId("rf__node-#response")).findByText(
      "(1 problem)",
    ),
  ).toBeTruthy();
  await openResponse();
  expect(
    screen.getByText(
      "200 (found) and 404 (gone) can both be reached in one run: join both to one transform, which picks the answer.",
    ),
  ).toBeTruthy();
});

test("a problem in an answer opens the response from the list, at the answer's schema", async () => {
  renderEditor(answering, [
    {
      pointer: "/response/answers/1/schema",
      code: "invalid_schema",
      detail: "- at '/type': value must be one of 'object', 'string'",
    },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(
    within(list).getByRole("button", { name: /^Response · 404 schema/ }),
  );
  const field = await screen.findByRole("textbox", { name: "404 schema" });
  await waitFor(() => expect(document.activeElement).toBe(field));
});

test("the list says where in the response each problem is", async () => {
  renderEditor(
    {
      ...answering,
      response: { answers: [{ status: 99 }], unhandled: { body: "" } },
    },
    [
      { pointer: "/response/answers/0/from", code: "required", detail: "" },
      {
        pointer: "/response/answers/0/status",
        code: "invalid_status",
        detail: "",
      },
      { pointer: "/response/unhandled/body", code: "required", detail: "" },
    ],
  );
  fireEvent.click(await screen.findByRole("button", { name: "3 problems" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  expect(
    within(list)
      .getAllByRole("button", { name: /^Response/ })
      .map((b) => b.textContent),
  ).toEqual([
    "Response · 99 · its lineJoin a step to this answer: drag from the step's point to the answer's.",
    "Response · 99 answerA status from 200 to 599.",
    "Response · UnhandledWrite its body, or use Conduit's problem details instead.",
  ]);
  // A problem in an answer's status opens it, at its Remove.
  fireEvent.click(
    within(list).getByRole("button", { name: /^Response · 99 answer/ }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove the 99 answer" }),
    ),
  );
});

test("picking a line into an answer opens the response, and Delete takes the line away", async () => {
  renderEditor(answering);
  fireEvent.click(await screen.findByTestId("rf__edge-gone->#response:1"));
  expect(
    await screen.findByRole("complementary", { name: "Response" }),
  ).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "Delete" });
  fireEvent.keyUp(document.body, { key: "Delete" });
  await waitFor(() =>
    expect(screen.queryByTestId("rf__edge-gone->#response:1")).toBeNull(),
  );
  // The step stays, and so does the answer.
  expect(screen.getByTestId("rf__node-gone")).toBeTruthy();
  expect(blocks()).toEqual(["200", "404", "409", "+ Add"]);
  expect(within(card()).getByText("From found")).toBeTruthy();
});

// dragFrom drags from a step's point in jsdom, which does no layout: what's
// under the pointer is told, the element over gives over the last move and
// while letting go, else nothing. React Flow reads it as the pointer moves.
function dragFrom(step: string, over: () => Element | null) {
  const point = screen
    .getByTestId(`rf__node-${step}`)
    .querySelector(".react-flow__handle.source");
  if (!point) throw new Error(`${step} has no point`);
  let under: Element | null = null;
  const before = document.elementFromPoint;
  document.elementFromPoint = () => under;
  try {
    fireEvent.mouseDown(point, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 40 });
    under = over();
    fireEvent.mouseMove(document, { clientX: 400, clientY: 40 });
    fireEvent.mouseUp(document, { clientX: 400, clientY: 40 });
  } finally {
    document.elementFromPoint = before;
  }
}

test("a line let go on an answer that has one says where it's from, until the next pick", async () => {
  renderEditor({
    ...answering,
    nodes: [
      ...answering.nodes,
      { id: "bad_400", kind: "transform", expr: "1" },
    ],
  });
  const status = within(
    await screen.findByTestId("rf__node-#response"),
  ).getByRole("status");
  expect(status.textContent).toBe("");
  dragFrom(
    "bad_400",
    () => card().querySelector('[data-part="404"] .react-flow__handle') ?? null,
  );
  await waitFor(() =>
    expect(status.textContent).toBe(
      "404 takes one line, from gone. To answer 404 from bad_400 too, join both to a transform, and the transform to the answer.",
    ),
  );
  expect(screen.queryByTestId("rf__edge-bad_400->#response:1")).toBeNull();
  fireEvent.click(
    within(screen.getByTestId("rf__node-bad_400")).getByText("bad_400"),
  );
  await waitFor(() => expect(status.textContent).toBe(""));
  // A line drawn again into the answer it already gives says nothing.
  dragFrom(
    "gone",
    () => card().querySelector('[data-part="404"] .react-flow__handle') ?? null,
  );
  await new Promise((r) => setTimeout(r));
  expect(status.textContent).toBe("");
});

test("a line let go on a card with no answers says to add one", async () => {
  renderEditor({
    nodes: [{ id: "respond", kind: "transform", expr: "1" }],
  });
  const status = within(
    await screen.findByTestId("rf__node-#response"),
  ).getByRole("status");
  dragFrom("respond", card);
  await waitFor(() =>
    expect(status.textContent).toBe(
      "Add an answer with + Add, then join respond to it.",
    ),
  );
  // A click on the canvas puts it away.
  const pane = document.querySelector(".react-flow__pane");
  if (!pane) throw new Error("no pane");
  fireEvent.click(pane);
  await waitFor(() => expect(status.textContent).toBe(""));
});

test("a step that leads nowhere, when every answer has its line, says to join both to a transform", async () => {
  renderEditor({
    ...answering,
    nodes: [
      ...answering.nodes,
      { id: "bad_400", kind: "transform", expr: "1" },
    ],
    response: { answers: answering.response?.answers?.slice(0, 2) },
  });
  fireEvent.click(await screen.findByText("bad_400"));
  await screen.findByRole("complementary", { name: "Transform step" });
  // Its value's, before its Unhandled's.
  expect(screen.getAllByText(/^None yet/)[0]?.textContent).toBe(
    "None yet: connect a step below, or drag from its point on the canvas to the step. Each answer on the response takes one line, and has it: to answer from here too, join this step and the one that gives the answer to a transform.",
  );
});

test("unhandled answers a run that gives none: written, warned about, and taken away", async () => {
  renderEditor(answering);
  const panel = await openResponse();
  expect(strip()?.textContent).toBe("Unhandled · problem details");
  fireEvent.click(
    within(panel).getByRole("button", { name: "Write your own" }),
  );
  const body = await within(panel).findByRole("textbox", {
    name: "Unhandled body",
  });
  expect(body).toHaveProperty("value", "{ 'error': error.detail }");
  expect(strip()?.textContent).toBe("Unhandled · your body");
  fireEvent.change(body, { target: { value: "$$" } });
  expect(
    within(panel).getByText(/^This sends callers what the run read/),
  ).toBeTruthy();
  fireEvent.click(
    within(panel).getByRole("button", {
      name: "Use Conduit's problem details instead",
    }),
  );
  await waitFor(() =>
    expect(strip()?.textContent).toBe("Unhandled · problem details"),
  );
});

test("a revision saved with an output opens with it moved into a step, to save", async () => {
  renderEditor({
    ...specExample,
    output: "{ 'id': nodes.crm.body.id }",
    output_schema: { type: "object" },
  });
  expect(await screen.findByTestId("rf__node-respond")).toBeTruthy();
  expect(screen.getByTestId("rf__edge-crm->respond")).toBeTruthy();
  expect(screen.getByTestId("rf__edge-respond->#response:0")).toBeTruthy();
  const note = /The output moved into a step, respond, joined to the response/;
  expect(screen.getByText(note)).toBeTruthy();

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
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByText(note)).toBeNull());
  expect(saved[0]?.response).toEqual({
    answers: [{ status: 200, from: "respond", schema: { type: "object" } }],
  });
  expect(saved[0]).not.toHaveProperty("output");
});
