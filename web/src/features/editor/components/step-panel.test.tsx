import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { SidePanel } from "@/features/editor/components/side-panel";
import { createEditorStore, EditorContext } from "@/features/editor/store";
import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { specExample } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { renderAt } from "@/test/render";
// For its cleanup between tests, and to fail on any request the editor makes.
import "@/test/server";

type Definition = components["schemas"]["Definition"];
type Request = components["schemas"]["HTTPRequest"];

shimReactFlow();

// withCrm is the spec example with crm's request swapped for another.
function withCrm(request: Request): Definition {
  return {
    ...specExample,
    nodes: specExample.nodes.map((n) =>
      n.id === "crm" ? { ...n, request } : n,
    ),
  };
}

// crm's request in the spec example.
const crm: Request = {
  method: "POST",
  url: "https://crm.example.com/v1/contacts",
};

// pick clicks a step on the canvas, as a user picks it.
async function pick(id: string) {
  fireEvent.click(await screen.findByText(id));
}

// reopen closes the step's settings and picks it again, so its fields show
// what the draft holds rather than what was typed.
async function reopen(id: string) {
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  await pick(id);
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

test("picking a step opens its settings, and Close puts them away", async () => {
  renderEditor(specExample);
  await pick("crm");
  const panel = await screen.findByRole("complementary", {
    name: "HTTP step",
  });
  expect(within(panel).getByLabelText("Id")).toHaveProperty("value", "crm");
  expect(within(panel).getByLabelText("URL")).toHaveProperty(
    "value",
    "https://crm.example.com/v1/contacts",
  );
  fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
});

// The canvas deletes what's selected on Delete or Backspace pressed anywhere
// but in a text field, which once took the step being edited with it.
test.each(["Close", "Add HTTP step"])(
  "Delete and Backspace on the %s button leave the step alone",
  async (button) => {
    renderEditor(specExample);
    await pick("crm");
    const target = await screen.findByRole("button", { name: button });
    target.focus();
    for (const key of ["Backspace", "Delete"]) {
      fireEvent.keyDown(target, { key });
      fireEvent.keyUp(target, { key });
    }
    // React Flow deletes asynchronously: give it its turn first.
    await new Promise((r) => setTimeout(r));
    expect(screen.getByText("crm")).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "HTTP step" }),
    ).toBeTruthy();
  },
);

test("an HTTP step's Response tab says how the steps after it read it", async () => {
  renderEditor(specExample);
  await pick("crm");
  const panel = await screen.findByRole("complementary", {
    name: "HTTP step",
  });
  const tab = (name: string) => within(panel).getByRole("tab", { name });
  expect(tab("Request").getAttribute("aria-selected")).toBe("true");
  type("Timeout (ms)", "30s");

  fireEvent.click(tab("Response"));
  expect(within(panel).queryByRole("textbox", { name: "URL" })).toBeNull();
  for (const part of ["status", "headers", "body"])
    expect(within(panel).getByText(`nodes.crm.${part}`)).toBeTruthy();
  // JSONata reads content-type as a subtraction without them.
  expect(
    within(panel).getByText("nodes.crm.headers.`content-type`"),
  ).toBeTruthy();

  // Text that doesn't count yet is still there after a switch.
  fireEvent.click(tab("Request"));
  expect(
    within(panel).getByRole("textbox", { name: "Timeout (ms)" }),
  ).toHaveProperty("value", "30s");
});

test("an arrow key moves to the other tab and opens it", async () => {
  renderEditor(specExample);
  await pick("crm");
  const request = await screen.findByRole("tab", { name: "Request" });
  request.focus();
  fireEvent.keyDown(request, { key: "ArrowRight" });
  expect(await screen.findByText("nodes.crm.status")).toBeTruthy();
});

test("the Response tab reads the step by the id it has now", async () => {
  renderEditor(specExample);
  await pick("crm");
  fireEvent.click(await screen.findByRole("tab", { name: "Response" }));
  const id = screen.getByLabelText("Id");
  type("Id", "contacts");
  fireEvent.blur(id);
  expect(await screen.findByText("nodes.contacts.body")).toBeTruthy();
});

test("the URL goes into the step as it's typed", async () => {
  renderEditor(specExample);
  await pick("crm");
  await screen.findByLabelText("URL");
  type("URL", "https://crm.example.com/v2/contacts");
  expect(
    await screen.findByText("POST https://crm.example.com/v2/contacts"),
  ).toBeTruthy();
});

test("an id is checked as it's typed and taken when the field is left", async () => {
  renderEditor(specExample);
  await pick("crm");
  const id = await screen.findByLabelText("Id");

  type("Id", "Crm");
  expect(await screen.findByText(/^A lowercase letter/)).toBeTruthy();
  type("Id", "orders");
  expect(
    await screen.findByText("Another step already has this id."),
  ).toBeTruthy();
  fireEvent.blur(id);
  expect(screen.getByText("crm")).toBeTruthy();

  type("Id", "contacts");
  fireEvent.blur(id);
  expect(await screen.findByText("contacts")).toBeTruthy();
  expect(screen.queryByText("crm")).toBeNull();
  // The settings stay open on the renamed step, and its edges go with it.
  expect(screen.getByRole("complementary", { name: "HTTP step" })).toBeTruthy();
  await waitFor(() =>
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(4),
  );
});

test("renaming says where expressions still read the old id", async () => {
  renderEditor(withCrm({ ...crm, body: '{"name": nodes.user.body.name}' }));
  await pick("user");
  const id = await screen.findByLabelText("Id");
  type("Id", "person");
  fireEvent.blur(id);
  const panel = screen.getByRole("complementary");
  const note = await within(panel).findByRole("status");
  expect(note.textContent).toBe(
    "Still reading nodes.user: crm's body. Change them to nodes.person.",
  );
  // What's code is set apart as code.
  expect(within(note).getByText("nodes.user")).toBeTruthy();
});

test("removing a header row leaves the other rows as they were", async () => {
  renderEditor(withCrm({ ...crm, headers: { A: "1", B: "2", C: "3" } }));
  await pick("crm");
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove header 2" }),
  );
  expect(screen.getByLabelText("Header 2 name")).toHaveProperty("value", "C");
  expect(screen.getByLabelText("Header 2 value")).toHaveProperty("value", "3");

  fireEvent.click(screen.getByRole("button", { name: "Add header" }));
  type("Header 3 name", "D");
  type("Header 3 value", "4");
  await reopen("crm");
  await screen.findByLabelText("Header 1 name");
  for (const [label, value] of [
    ["Header 1 name", "A"],
    ["Header 2 name", "C"],
    ["Header 3 name", "D"],
    ["Header 3 value", "4"],
  ] as const)
    expect(screen.getByLabelText(label)).toHaveProperty("value", value);
  expect(screen.queryByLabelText("Header 4 name")).toBeNull();
});

test("a repeated header name is marked, and the first one counts", async () => {
  renderEditor(withCrm({ ...crm, headers: { A: "1" } }));
  await pick("crm");
  fireEvent.click(await screen.findByRole("button", { name: "Add header" }));
  type("Header 2 name", "A");
  type("Header 2 value", "2");
  expect(await screen.findByText("Another header has this name.")).toBeTruthy();
  await reopen("crm");
  expect(await screen.findByLabelText("Header 1 value")).toHaveProperty(
    "value",
    "1",
  );
  expect(screen.queryByLabelText("Header 2 name")).toBeNull();
});

test("a number is kept once it's a whole number in range", async () => {
  renderEditor(specExample);
  await pick("crm");
  await screen.findByLabelText("Timeout (ms)");
  type("Timeout (ms)", "30s");
  expect(
    await screen.findByText(/^A whole number of milliseconds/),
  ).toBeTruthy();
  type("Attempts", "9");
  expect(await screen.findByText("A whole number from 2 to 5.")).toBeTruthy();
  await reopen("crm");
  expect(await screen.findByLabelText("Timeout (ms)")).toHaveProperty(
    "value",
    "",
  );
  expect(screen.getByLabelText("Attempts")).toHaveProperty("value", "");

  type("Timeout (ms)", "5000");
  type("Attempts", "3");
  fireEvent.click(screen.getByRole("checkbox", { name: "Idempotent" }));
  await reopen("crm");
  expect(await screen.findByLabelText("Timeout (ms)")).toHaveProperty(
    "value",
    "5000",
  );
  expect(screen.getByLabelText("Attempts")).toHaveProperty("value", "3");
  expect(
    screen
      .getByRole("checkbox", { name: "Idempotent" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("a transform's expression goes into the step as it's typed", async () => {
  renderEditor({ nodes: [{ id: "merge", kind: "transform", expr: "1" }] });
  await pick("merge");
  await screen.findByRole("complementary", { name: "Transform step" });
  type("Expression", "nodes.user.body");
  expect(await screen.findByText("nodes.user.body")).toBeTruthy();
});

test("a transform step says how the steps after it read its value", async () => {
  renderEditor({ nodes: [{ id: "merge", kind: "transform", expr: "1" }] });
  await pick("merge");
  const panel = await screen.findByRole("complementary", {
    name: "Transform step",
  });
  expect(within(panel).getByText("nodes.merge.body")).toBeTruthy();
});

// Looking at a step, or typing what doesn't count yet, mustn't count as
// changing it: nothing could tell an untouched draft from a changed one.
test("typing that leaves the step as it was changes nothing", async () => {
  const store = createEditorStore(specExample);
  store.getState().pick("nodes", [{ id: "crm", selected: true }]);
  renderAt(
    <EditorContext value={store}>
      <SidePanel />
    </EditorContext>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Add header" }));
  type("Header 1 value", "no name yet");
  type("Timeout (ms)", "30s");
  for (const label of ["Id", "URL", "Body", "Attempts"]) {
    fireEvent.focus(screen.getByLabelText(label));
    fireEvent.blur(screen.getByLabelText(label));
  }
  expect(store.getState().draft).toBe(specExample);
});
