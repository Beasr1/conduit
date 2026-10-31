import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { shimReactFlow } from "@/test/react-flow";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type Preview = components["schemas"]["Preview"];

shimReactFlow();

// respond gives one value, and is joined to 200 and 400.
const respond: Definition = {
  nodes: [{ id: "respond", kind: "transform", expr: "{ 'id': 1 }" }],
  response: {
    answers: [
      { status: 200, from: "respond" },
      { status: 400, from: "respond" },
    ],
  },
};

const field = (name: string) => screen.getByRole("textbox", { name });

function type(name: string, value: string) {
  fireEvent.change(field(name), { target: { value } });
}

async function open() {
  fireEvent.click(await screen.findByText("respond"));
  return screen.findByRole("complementary", { name: "Transform step" });
}

const line = () =>
  within(screen.getByTestId("rf__node-respond")).getAllByText(
    (_text, el) => el?.tagName === "SPAN" && el.className.includes("text-xs"),
  )[0]?.textContent;

test("Use cases makes the expression Otherwise's, and cases are added, moved and removed", async () => {
  renderEditor(respond);
  const panel = await open();
  fireEvent.click(within(panel).getByRole("button", { name: "Use cases" }));
  expect(
    await screen.findByRole("textbox", { name: "Otherwise body" }),
  ).toHaveProperty("value", "{ 'id': 1 }");
  // Otherwise answers with the first answer the step is joined to.
  expect(field("Otherwise status")).toHaveProperty("value", "200");

  // A new case answers with an answer the step is joined to that no case
  // gives yet, else Otherwise's.
  fireEvent.click(screen.getByRole("button", { name: "+ Add a case" }));
  expect(
    await screen.findByRole("textbox", { name: "Case 1 status" }),
  ).toHaveProperty("value", "400");
  type("Case 1 when", "input.key = 1");
  fireEvent.click(screen.getByRole("button", { name: "+ Add a case" }));
  expect(
    await screen.findByRole("textbox", { name: "Case 2 status" }),
  ).toHaveProperty("value", "200");
  type("Case 2 when", "input.key = 2");
  expect(line()).toBe("400 · 200 · else 200");

  // The first case that holds answers, so their order matters.
  fireEvent.click(screen.getByRole("button", { name: "Move case 2 up" }));
  await waitFor(() =>
    expect(field("Case 1 when")).toHaveProperty("value", "input.key = 2"),
  );
  expect(field("Case 2 when")).toHaveProperty("value", "input.key = 1");
  expect(screen.getByRole("button", { name: "Move case 1 up" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove case 1" }));
  await waitFor(() =>
    expect(field("Case 1 when")).toHaveProperty("value", "input.key = 1"),
  );
  expect(screen.queryByRole("textbox", { name: "Case 2 when" })).toBeNull();
  expect(line()).toBe("400 · else 200");
});

test("a status that isn't 200 to 599 says so, and the one held stays", async () => {
  renderEditor({
    ...respond,
    nodes: [
      {
        id: "respond",
        kind: "transform",
        switch: {
          cases: [{ when: "true", status: 400 }],
          otherwise: { status: 200 },
        },
      },
    ],
  });
  await open();
  type("Case 1 status", "99");
  expect(screen.getByText("A whole number from 200 to 599.")).toBeTruthy();
  expect(line()).toBe("400 · else 200");
  type("Case 1 status", "404");
  await waitFor(() => expect(line()).toBe("404 · else 200"));
});

test("a field picked from what the step reads goes where the cursor was last", async () => {
  renderEditor({
    ...respond,
    nodes: [
      {
        id: "respond",
        kind: "transform",
        switch: {
          cases: [{ when: "", status: 400 }],
          otherwise: { status: 200, body: "{ 'ok': true }" },
        },
      },
    ],
  });
  server.use(
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: { key: 1 }, nodes: {} },
        gives: { status: 400, body: { error: "bad key" } },
        skipped: false,
        problems: [],
      }),
    ),
  );
  const panel = await open();
  const insert = await within(panel).findByRole("button", {
    name: "Insert input.key",
  });
  // Before any field has had the cursor, the first case's condition.
  fireEvent.click(insert);
  await waitFor(() =>
    expect(field("Case 1 when")).toHaveProperty("value", "input.key"),
  );
  // Then where the cursor is.
  const body = field("Otherwise body") as HTMLTextAreaElement; // a textbox, by its role
  fireEvent.focus(body);
  body.setSelectionRange(0, 0);
  fireEvent.click(insert);
  await waitFor(() => expect(body.value).toBe("input.key{ 'ok': true }"));
  // And what it gives over the samples: the case that holds.
  expect(
    within(panel).getByRole("heading", { name: "It answers 400" }),
  ).toBeTruthy();
  expect(within(panel).getByText(/"error": "bad key"/)).toBeTruthy();
});

test("a body that sends what the run read is warned about", async () => {
  renderEditor({
    ...respond,
    nodes: [
      {
        id: "respond",
        kind: "transform",
        switch: { otherwise: { status: 200, body: "nodes.user.body" } },
      },
    ],
  });
  const panel = await open();
  expect(within(panel).queryByText(/^This sends callers/)).toBeNull();
  type("Otherwise body", "{ 'debug': $$ }");
  expect(within(panel).getByText(/^This sends callers/)).toBeTruthy();
  type("Otherwise body", "{ 'trace': nodes.user.headers }");
  expect(within(panel).getByText(/^This sends callers/)).toBeTruthy();
  type("Otherwise body", "$$.input.id");
  expect(within(panel).queryByText(/^This sends callers/)).toBeNull();
});
