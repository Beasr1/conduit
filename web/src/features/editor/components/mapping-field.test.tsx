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

// What the Spec example's crm reads, with user's sample in it.
const reads = {
  input: { user_id: "7" },
  nodes: {
    user: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: "7", email: "ada@example.com" },
    },
  },
};

// field finds a text field by its label, as a screen reader does: a hidden
// tab's fields aren't there.
function field(label: string) {
  return screen.getByRole("textbox", { name: label });
}

function type(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } });
}

// open picks a step, or the response card, which opens on its request.
async function open(id: string) {
  fireEvent.click(await screen.findByText(id));
}

async function close() {
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
}

test("the request body shows what the step reads, what it makes and what it sends", async () => {
  renderEditor(specExample);
  const asked: PreviewRequest[] = [];
  server.use(
    http.post<PathParams, PreviewRequest, Preview>(
      "/api/v1/preview",
      async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json({
          reads,
          sends: {
            method: "POST",
            url: "https://crm.example.com/v1/contacts",
            headers: { "X-Orders": "2" },
            body: { email: "ada@example.com" },
          },
          skipped: false,
          problems: [
            {
              pointer: "/nodes/2/sample",
              code: "missing_sample",
              detail:
                "prefs has no sample response, so what it gets back isn't there to read",
            },
          ],
        });
      },
    ),
  );
  await open("crm");
  const panel = screen.getByRole("tabpanel", { name: "Request" });
  // The input, as a tree of what it can read. A step it has no connection
  // from starts folded: crm's come from orders and prefs.
  expect(
    await within(panel).findByRole("button", { name: "Insert input.user_id" }),
  ).toBeTruthy();
  expect(
    within(panel).queryByRole("button", { name: "Insert nodes.user.body" }),
  ).toBeNull();
  fireEvent.click(
    within(panel).getByRole("button", { name: "Expand nodes.user" }),
  );
  expect(
    within(panel).getByRole("button", { name: "Insert nodes.user.body.email" }),
  ).toBeTruthy();
  // What it sends.
  expect(
    within(panel).getByText("POST https://crm.example.com/v1/contacts"),
  ).toBeTruthy();
  expect(within(panel).getByText(/"email": "ada@example\.com"/)).toBeTruthy();
  expect(within(panel).getByText("X-Orders:")).toBeTruthy();
  // What got in the way.
  expect(
    within(panel).getByText(
      "Prefs has no sample response, so what it gets back isn't there to read.",
    ),
  ).toBeTruthy();
  expect(asked[0]?.node).toBe("crm");
});

test("picking a field of the input puts its path where the cursor is", async () => {
  renderEditor(specExample);
  server.use(
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({ reads, skipped: false, problems: [] }),
    ),
  );
  await open("crm");
  fireEvent.click(
    await screen.findByRole("button", { name: "Expand nodes.user" }),
  );
  const insert = screen.getByRole("button", {
    name: "Insert nodes.user.body.email",
  });

  // Before the field is used, at the end.
  fireEvent.click(insert);
  expect(field("Request body")).toHaveProperty(
    "value",
    "nodes.user.body.email",
  );

  // Then where the cursor is.
  type("Request body", '{ "email":  }');
  const body = field("Request body") as HTMLTextAreaElement; // a textbox, by its role
  fireEvent.focus(body);
  body.setSelectionRange(11, 11);
  fireEvent.click(insert);
  expect(body.value).toBe('{ "email": nodes.user.body.email }');

  // And the step holds it.
  await close();
  await open("crm");
  expect(field("Request body")).toHaveProperty(
    "value",
    '{ "email": nodes.user.body.email }',
  );
});

test("a transform step and the response card preview what they give", async () => {
  renderEditor({
    nodes: [{ id: "merge", kind: "transform", expr: "{ 'who': 'ADA' }" }],
    output: "nodes.merge.body",
  });
  server.use(
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: null, nodes: {} },
        gives: { who: "ADA" },
        skipped: false,
        problems: [],
      }),
    ),
  );
  await open("merge");
  const step = await screen.findByRole("complementary", {
    name: "Transform step",
  });
  expect(
    await within(step).findByRole("heading", { name: "It gives" }),
  ).toBeTruthy();
  expect(within(step).getByText(/"who": "ADA"/)).toBeTruthy();

  await close();
  await open("Response");
  const card = await screen.findByRole("complementary", { name: "Response" });
  expect(
    await within(card).findByRole("heading", { name: "It answers" }),
  ).toBeTruthy();
});
