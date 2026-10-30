import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { specExample } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type Validation = components["schemas"]["Validation"];

shimReactFlow();

// noURL is the spec example with crm's URL left empty, and urlRequired the
// problem the server finds in it.
const noURL: Definition = {
  ...specExample,
  nodes: specExample.nodes.map((n) =>
    n.id === "crm" ? { ...n, request: { method: "POST", url: "" } } : n,
  ),
};
const urlRequired = {
  pointer: "/nodes/3/request/url",
  code: "required",
  detail: "a request needs a url",
};

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

test("a problem shows on its step, its field, its tab and in the list", async () => {
  renderEditor(noURL, [urlRequired]);
  const crm = await screen.findByTestId("rf__node-crm");
  expect(within(crm).getByText("(1 problem)")).toBeTruthy();

  fireEvent.click(within(crm).getByText("crm"));
  const panel = await screen.findByRole("complementary", {
    name: "HTTP step",
  });
  expect(within(panel).getByText("Add a URL.")).toBeTruthy();
  expect(within(panel).getByLabelText("URL").getAttribute("aria-invalid")).toBe(
    "true",
  );
  // Seen from the Response tab, the Request tab still says it has one.
  fireEvent.click(within(panel).getByRole("tab", { name: "Response" }));
  expect(
    within(panel).getByRole("tab", { name: "Request (1 problem)" }),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(within(list).getByRole("button", { name: /^crm · URL/ }));
  const opened = await screen.findByRole("complementary", {
    name: "HTTP step",
  });
  expect(within(opened).getByLabelText("Id")).toHaveProperty("value", "crm");
  // The cursor goes to the field the problem is about.
  await waitFor(() =>
    expect(document.activeElement).toBe(within(opened).getByLabelText("URL")),
  );
});

test("the draft is checked a moment after it changes", async () => {
  renderEditor(specExample);
  server.use(
    http.post("/api/v1/validate", async ({ request }) => {
      const draft = (await request.json()) as Definition;
      const url = draft.nodes.find((n) => n.id === "crm")?.request?.url;
      return HttpResponse.json<Validation>({
        problems: url ? [] : [urlRequired],
      });
    }),
  );
  fireEvent.click(await screen.findByText("crm"));
  await screen.findByLabelText("URL");

  type("URL", "");
  expect(await screen.findByText("Add a URL.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "1 problem" })).toBeTruthy();
  type("URL", "https://crm.example.com/v2/contacts");
  await waitFor(() => expect(screen.queryByText("Add a URL.")).toBeNull());
  expect(screen.queryByRole("button", { name: "1 problem" })).toBeNull();
});

test("a connection with a problem says so, and its condition says what", async () => {
  renderEditor(
    {
      ...specExample,
      edges: (specExample.edges ?? []).map((e, i) =>
        i === 0 ? { ...e, when: "nodes.user.status =" } : e,
      ),
    },
    [
      {
        pointer: "/edges/0/when",
        code: "invalid_expression",
        detail:
          'JSONata error S0207 at token "EOF": unexpected end of expression',
      },
    ],
  );
  expect(await screen.findByText("if · problem")).toBeTruthy();
  fireEvent.click(screen.getByTestId("rf__edge-user->orders"));
  const panel = await screen.findByRole("complementary", {
    name: "Connection",
  });
  expect(
    within(panel).getByText(
      'JSONata error S0207 at token "EOF": unexpected end of expression.',
    ),
  ).toBeTruthy();
});

test("a schema problem marks the settings, and shows under its field", async () => {
  renderEditor({ ...specExample, input_schema: { type: "nope" } }, [
    {
      pointer: "/input_schema",
      code: "invalid_schema",
      detail:
        "\"https://conduit.invalid/schema.json#\" is not valid against metaschema\n- at '/type': value must be one of 'object', 'string'",
    },
  ]);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Workflow settings (1 problem)",
    }),
  );
  const panel = await screen.findByRole("complementary", {
    name: "Workflow settings",
  });
  expect(
    within(panel).getByText(
      "Not a valid JSON Schema: at /type, value must be one of 'object', 'string'.",
    ),
  ).toBeTruthy();
});

// The canvas can't draw a connection whose end names no step, so the list
// offers to remove it.
test("a connection to a missing step can be removed from the list", async () => {
  renderEditor(
    {
      ...specExample,
      edges: [...(specExample.edges ?? []), { from: "crm", to: "gone" }],
    },
    [
      {
        pointer: "/edges/4/to",
        code: "unknown_node",
        detail: 'no node has the id "gone"',
      },
    ],
  );
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  expect(within(list).getByText("No step has the id “gone”.")).toBeTruthy();
  fireEvent.click(
    within(list).getByRole("button", { name: "Remove connection" }),
  );
  expect(await within(list).findByText("No problems.")).toBeTruthy();
});
