import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { specExample } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { server } from "@/test/server";

type Preview = components["schemas"]["Preview"];
type PreviewRequest = components["schemas"]["PreviewRequest"];

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
    "From prefs, on 2xx, to crm.",
  );

  type("Condition", "nodes.prefs.status = 200");
  expect(await screen.findByText("if")).toBeTruthy();
  type("Condition", " ");
  await waitFor(() => expect(screen.queryByText("if")).toBeNull());
});

test("a connection says which response it leaves from, and whether it's taken", async () => {
  // user answers 2xx or 404, and crm follows its 404 too.
  renderEditor({
    ...specExample,
    nodes: specExample.nodes.map((n) =>
      n.id === "user" ? { ...n, outputs: [{ status: 404 }] } : n,
    ),
    edges: [...(specExample.edges ?? []), { from: "user", to: "crm", on: 404 }],
  });
  const asked: PreviewRequest[] = [];
  server.use(
    http.post<PathParams, PreviewRequest, Preview>(
      "/api/v1/preview",
      async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json({
          reads: {
            input: { user_id: "7" },
            nodes: {
              user: { status: 404, headers: {}, body: { error: "gone" } },
            },
          },
          taken: false,
          skipped: false,
          problems: [],
        });
      },
    ),
  );
  fireEvent.click(await screen.findByTestId("rf__edge-user->crm"));
  const panel = await screen.findByRole("complementary", {
    name: "Connection",
  });
  expect(within(panel).getByText(/^From/).textContent).toBe(
    "From user, on 404, to crm.",
  );
  expect(
    await within(panel).findByText(
      "Not taken. crm runs only if another connection into it is.",
    ),
  ).toBeTruthy();
  // What the condition reads, the connection's step open.
  expect(
    within(panel).getByRole("button", { name: "Insert nodes.user.body.error" }),
  ).toBeTruthy();
  expect(asked[0]?.edge).toBe(4);
  expect(asked[0]?.node).toBeUndefined();
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
  fireEvent.click(
    within(panel).getByRole("button", { name: "Format input schema" }),
  );
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

test("the sample input is kept once it's JSON", async () => {
  renderEditor(specExample);
  const settings = async () => {
    fireEvent.click(
      await screen.findByRole("button", { name: "Workflow settings" }),
    );
    return screen.findByRole("complementary", { name: "Workflow settings" });
  };
  await settings();
  type("Sample input", '{"user_id": "7"}');
  await close();
  await settings();
  expect(screen.getByLabelText("Sample input")).toHaveProperty(
    "value",
    '{\n  "user_id": "7"\n}',
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
