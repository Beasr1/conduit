import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { choose } from "@/test/choose";
import { renderEditor } from "@/test/editor";
import { specExample, workflowRevision } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type Revision = components["schemas"]["Revision"];

shimReactFlow();

// saving has the server keep what Save sends; save clicks it and gives that.
function saving() {
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
  return async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    return saved[0];
  };
}

const offered = () =>
  [...document.querySelectorAll("#workflow-masked-input-offered option")].map(
    (o) => o.getAttribute("value"),
  );

async function settings() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Workflow settings" }),
  );
  const panel = await screen.findByRole("complementary", {
    name: "Workflow settings",
  });
  return within(panel).getByRole("region", { name: "Masked input fields" });
}

// The run's input fields are marked to be kept masked in Workflow
// settings, offered from the sample input, each with how it's kept, and
// saved in the draft (plan 17).
test("Workflow settings marks input fields to be masked, and saves them", async () => {
  renderEditor({
    ...specExample,
    sample_input: {
      customer: { eid: "784199012345671", name: "Fatima" },
      user_id: "7",
    },
  });
  const save = saving();
  const masked = await settings();
  expect(offered()).toEqual(["customer.eid", "customer.name", "user_id"]);
  fireEvent.change(
    within(masked).getByRole("combobox", { name: "Add a masked field" }),
    { target: { value: "customer.eid" } },
  );
  fireEvent.click(within(masked).getByRole("button", { name: "Add" }));
  // Marked, it's offered no more, and it's all hidden until said otherwise:
  // a field marked is masked, so it's removed rather than unmasked.
  expect(offered()).toEqual(["customer.name", "user_id"]);
  const kind = within(masked).getByRole("combobox", {
    name: "Mask of customer.eid",
  });
  expect(kind.textContent).toContain("All of it");
  kind.focus();
  fireEvent.keyDown(kind, { key: "ArrowDown" });
  expect(
    await screen.findByRole("option", { name: "Keep the end" }),
  ).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Not masked" })).toBeNull();
  await choose("Mask of customer.eid", "Keep the end");
  const end = within(masked).getByRole("spinbutton", {
    name: "Characters kept at the end of customer.eid",
  });
  expect(end).toHaveProperty("value", "4");
  fireEvent.change(end, { target: { value: "3" } });
  fireEvent.change(end, { target: { value: "" } });
  expect(end).toHaveProperty("value", "3");
  expect((await save())?.masked_input).toEqual([
    { field: "customer.eid", mask: { end: 3 } },
  ]);
});

test("removing the last masked input field leaves the draft with none", async () => {
  renderEditor({
    ...specExample,
    masked_input: [{ field: "customer.eid", mask: {} }],
  });
  const save = saving();
  const masked = await settings();
  fireEvent.click(
    within(masked).getByRole("button", { name: "Stop masking customer.eid" }),
  );
  expect(within(masked).queryByRole("textbox")).toBeNull();
  expect(await save()).not.toHaveProperty("masked_input");
});

// A problem with a masked input field shows under it, and the list of
// problems names where, and opens it.
test("a masked input field's problem shows under it, and in the list", async () => {
  renderEditor(
    {
      ...specExample,
      masked_input: [
        { field: "ok", mask: {} },
        { field: "first-name", mask: {} },
      ],
    },
    [
      {
        pointer: "/masked_input/1/field",
        code: "invalid_field",
        detail: `"first-name" isn't a name: use letters, digits and underscores, starting with a letter or underscore, or put it in backticks`,
      },
    ],
  );
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(
    within(list).getByRole("button", {
      name: /^Workflow settings · Masked input fields/,
    }),
  );
  const panel = await screen.findByRole("complementary", {
    name: "Workflow settings",
  });
  const masked = within(panel).getByRole("region", {
    name: "Masked input fields",
  });
  // The cursor goes to where a field is added.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(masked).getByRole("combobox", { name: "Add a masked field" }),
    ),
  );
  const said = `"first-name" isn't a name: use letters, digits and underscores, starting with a letter or underscore, or put it in backticks.`;
  const row = within(masked)
    .getByRole("textbox", { name: "Masked field first-name" })
    .closest("div.flex-col");
  expect(row?.textContent).toContain(said);
  expect(
    within(masked)
      .getByRole("textbox", { name: "Masked field ok" })
      .closest("div.flex-col")?.textContent,
  ).not.toContain(said);
  // Another field changed, the problem stays with its own until the next
  // check says.
  fireEvent.change(
    within(masked).getByRole("textbox", { name: "Masked field ok" }),
    { target: { value: "okay" } },
  );
  expect(row?.textContent).toContain(said);
});
