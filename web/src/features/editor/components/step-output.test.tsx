import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { renderEditor } from "@/test/editor";
import { specExample } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
// For its cleanup between tests, and to fail on any request the editor makes.
import "@/test/server";

shimReactFlow();

// field finds a text field by its label, as a screen reader does: a hidden
// tab's fields aren't there.
function field(label: string) {
  return screen.getByRole("textbox", { name: label });
}

function type(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } });
}

function tab(name: string) {
  return screen.getByRole("tab", { name });
}

// open picks a step, as a click on its id does, and opens one of its tabs.
async function open(id: string, name?: string) {
  fireEvent.click(await screen.findByText(id));
  if (name) fireEvent.click(await screen.findByRole("tab", { name }));
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

// choose picks one of a select's options.
async function choose(label: string, option: string) {
  await options(label);
  fireEvent.click(screen.getByRole("option", { name: option }));
}

// user answers 2xx or 404, and crm follows its 404 too, when it's gone.
const branched = {
  ...specExample,
  nodes: specExample.nodes.map((n) =>
    n.id === "user"
      ? {
          ...n,
          outputs: [{ status: 404, sample: { body: { error: "gone" } } }],
        }
      : n,
  ),
  edges: [
    ...(specExample.edges ?? []),
    {
      from: "user",
      to: "crm",
      on: 404,
      when: 'nodes.user.body.error = "gone"',
    },
  ],
};

test("a sample response is kept once its body is JSON, and empty removes it", async () => {
  renderEditor(specExample);
  await open("crm", "2xx");
  type("2xx body", '{"id": 7');
  expect(await screen.findByText(/^Not JSON yet/)).toBeTruthy();
  type("2xx body", '{"id": 7}');
  type("2xx status", "404");
  expect(screen.getByText("A whole number from 200 to 299.")).toBeTruthy();
  type("2xx status", "201");

  // Opened again, the fields show what the step holds.
  await close();
  await open("crm", "2xx");
  expect(field("2xx body")).toHaveProperty("value", '{\n  "id": 7\n}');
  expect(field("2xx status")).toHaveProperty("value", "201");

  type("2xx body", "");
  await close();
  await open("crm", "2xx");
  expect(field("2xx body")).toHaveProperty("value", "");
});

test("a response is added by its status, and its tab opens", async () => {
  renderEditor(specExample);
  await open("user", "Add a response");
  type("Add a response", "200");
  expect(
    screen.getByText("A whole number from 300 to 599: 2xx is always there."),
  ).toBeTruthy();
  type("Add a response", "404");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(tab("404").getAttribute("aria-selected")).toBe("true");
  type("404 body", '{"error": "gone"}');

  fireEvent.click(tab("Add a response"));
  expect(field("Add a response")).toHaveProperty("value", "");
  type("Add a response", "404");
  expect(
    screen.getByText("It has a response for that status already."),
  ).toBeTruthy();

  // The step draws the response as a block, and holds its sample.
  const step = screen.getByTestId("rf__node-user");
  expect(within(step).getByText("2xx")).toBeTruthy();
  expect(within(step).getByText("404")).toBeTruthy();
  await close();
  await open("user", "404");
  expect(field("404 body")).toHaveProperty("value", '{\n  "error": "gone"\n}');
});

test("removing a response removes its tab and the connections that leave from it", async () => {
  renderEditor(branched);
  expect(await screen.findByTestId("rf__edge-user->crm")).toBeTruthy();
  await open("user", "404");
  fireEvent.click(
    screen.getByRole("button", { name: "Remove the 404 response" }),
  );
  await waitFor(() =>
    expect(screen.queryByTestId("rf__edge-user->crm")).toBeNull(),
  );
  expect(screen.queryByRole("tab", { name: "404" })).toBeNull();
  expect(tab("Request").getAttribute("aria-selected")).toBe("true");
  expect(
    within(screen.getByTestId("rf__node-user")).queryByText("404"),
  ).toBeNull();
  expect(screen.getByTestId("rf__edge-user->orders")).toBeTruthy();
});

test("a response lists the connections that leave on it, each opening its line", async () => {
  renderEditor(branched);
  await open("user", "2xx");
  const ok = screen.getByRole("tabpanel", { name: "2xx" });
  expect(
    within(ok)
      .getAllByRole("button", { name: /^Connection to/ })
      .map((b) => b.textContent),
  ).toEqual(["Connection to orders always", "Connection to prefs always"]);

  fireEvent.click(tab("404"));
  const gone = screen.getByRole("tabpanel", { name: "404" });
  fireEvent.click(
    within(gone).getByRole("button", {
      name: 'Connection to crm if nodes.user.body.error = "gone"',
    }),
  );
  const panel = await screen.findByRole("complementary", {
    name: "Connection",
  });
  expect(within(panel).getByText(/^From/).textContent).toBe(
    "From user, on 404, to crm.",
  );
});

test("Connect to joins a step on a response, without drawing", async () => {
  renderEditor(branched);
  await open("orders", "2xx");
  // Not orders itself, nor crm, which it's joined to already, nor user,
  // which would make a loop.
  expect(await options("Connect to")).toEqual(["prefs"]);
  fireEvent.click(screen.getByRole("option", { name: "prefs" }));
  expect(await screen.findByTestId("rf__edge-orders->prefs")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Connection to prefs always" }),
  ).toBeTruthy();
});

test("a transform step lists its connections and connects too", async () => {
  renderEditor({
    nodes: [
      { id: "merge", kind: "transform", expr: "1" },
      {
        id: "crm",
        kind: "http",
        request: { method: "POST", url: "https://crm.example.com/v1" },
      },
    ],
  });
  await open("merge");
  expect(screen.getByText(/^None yet/)).toBeTruthy();
  await choose("Connect to", "crm");
  expect(await screen.findByTestId("rf__edge-merge->crm")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Connection to crm always" }),
  ).toBeTruthy();
});

test("a problem in a sample opens the 2xx tab, at the sample's body", async () => {
  renderEditor(
    {
      ...specExample,
      nodes: specExample.nodes.map((n) =>
        n.id === "crm" ? { ...n, sample: { status: 99, body: {} } } : n,
      ),
    },
    [
      {
        pointer: "/nodes/3/sample/status",
        code: "invalid_status",
        detail: "the status 99 isn't 200 to 299",
      },
    ],
  );
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(
    within(list).getByRole("button", { name: /^crm · 2xx response/ }),
  );
  await waitFor(() => expect(document.activeElement).toBe(field("2xx body")));
  expect(tab("2xx (1 problem)").getAttribute("aria-selected")).toBe("true");
});
