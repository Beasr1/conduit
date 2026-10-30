import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { renderEditor } from "@/test/editor";
import { specExample } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
// For its cleanup between tests, and to fail on any request the editor makes.
import "@/test/server";

shimReactFlow();

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function close() {
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
}

test("picking a connection opens its condition, and a condition labels it", async () => {
  renderEditor(specExample);
  fireEvent.click(await screen.findByTestId("rf__edge-prefs->crm"));
  const panel = await screen.findByRole("complementary", {
    name: "Connection",
  });
  expect(within(panel).getByText(/^From/).textContent).toBe(
    "From prefs to crm.",
  );

  type("Condition", "nodes.prefs.status = 200");
  expect(await screen.findByText("if")).toBeTruthy();
  type("Condition", " ");
  await waitFor(() => expect(screen.queryByText("if")).toBeNull());
});

test("the response card says what the output reads, and opens it", async () => {
  renderEditor({ ...specExample, output: "nodes.crm.body" });
  expect(await screen.findByText("Reads crm")).toBeTruthy();
  fireEvent.click(screen.getByText("Response"));
  const panel = await screen.findByRole("complementary", { name: "Response" });
  expect(within(panel).getByLabelText("Output")).toHaveProperty(
    "value",
    "nodes.crm.body",
  );

  type("Output", '{ "user": nodes.user.body, "crm": nodes.crm.body }');
  expect(await screen.findByText("Reads user, crm")).toBeTruthy();
  type("Output", "");
  expect(await screen.findByText("No output yet")).toBeTruthy();
});

test("the input schema is kept once it's a JSON object", async () => {
  renderEditor(specExample);
  const open = async () => {
    fireEvent.click(
      await screen.findByRole("button", { name: "Workflow settings" }),
    );
    return screen.findByRole("complementary", { name: "Workflow settings" });
  };

  let panel = await open();
  type("Input schema", '{"type": "object"');
  expect(await within(panel).findByText(/^Not JSON yet/)).toBeTruthy();
  await close();
  panel = await open();
  expect(within(panel).getByLabelText("Input schema")).toHaveProperty(
    "value",
    "",
  );

  type("Input schema", '{"type": "object", "required": ["id"]}');
  fireEvent.click(within(panel).getByRole("button", { name: "Format" }));
  const formatted = '{\n  "type": "object",\n  "required": [\n    "id"\n  ]\n}';
  expect(screen.getByLabelText("Input schema")).toHaveProperty(
    "value",
    formatted,
  );
  await close();
  panel = await open();
  expect(within(panel).getByLabelText("Input schema")).toHaveProperty(
    "value",
    formatted,
  );
});

test("picking a step while the workflow's settings are open shows the step", async () => {
  renderEditor(specExample);
  fireEvent.click(
    await screen.findByRole("button", { name: "Workflow settings" }),
  );
  await screen.findByRole("complementary", { name: "Workflow settings" });
  fireEvent.click(screen.getByText("crm"));
  expect(
    await screen.findByRole("complementary", { name: "HTTP step" }),
  ).toBeTruthy();
});
