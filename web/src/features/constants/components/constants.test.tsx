import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { Component as ConstantsPage } from "@/routes/constants";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type Constant = components["schemas"]["Constant"];
type ConstantList = components["schemas"]["ConstantList"];
type ConstantUsers = components["schemas"]["ConstantUsers"];
type CreateConstant = components["schemas"]["CreateConstant"];
type SetConstant = components["schemas"]["SetConstant"];

const at = "2026-11-04T00:00:00Z";

const constant = (c: Partial<Constant> & { name: string }): Constant => ({
  secret: false,
  has_previous: false,
  provenance: { actor: "token" },
  updated_at: at,
  created_at: at,
  ...c,
});

// base_path is plain, read by nothing; crm_token is secret, changed once,
// and read by a workflow and an upstream.
const constants = [
  constant({ name: "base_path", value: "tenant-a" }),
  constant({ name: "crm_token", secret: true, has_previous: true }),
];

// answer has the server answer the page: the constants, kept in the list
// it gives back for a test's own handlers to change, and what reads each.
function answer(start: Constant[] = constants): Constant[] {
  const list = [...start];
  server.use(
    http.get("/api/v1/constants", () =>
      HttpResponse.json<ConstantList>({ constants: list }),
    ),
    http.get("/api/v1/constants/:name/users", ({ params }) =>
      HttpResponse.json<ConstantUsers>(
        params.name === "crm_token"
          ? {
              workflows: [{ workflow_id: "wf-1", name: "Orders", revision: 3 }],
              upstreams: [{ upstream_id: "u-1", name: "CRM", version: 2 }],
            }
          : { workflows: [], upstreams: [] },
      ),
    ),
  );
  return list;
}

function renderPage() {
  renderAt(<ConstantsPage />, {
    path: "/constants",
    routes: ["/workflows/:id", "/upstreams/:id"],
  });
}

const row = async (name: string) =>
  (await screen.findByRole("cell", { name })).closest("tr")!;

// The list says a plain constant's value, and of a secret one only that it
// is; what reads each, as links; and offers Undo where there's a value to
// go back to.
test("the list shows a plain value, a secret as secret, and what reads each", async () => {
  answer();
  renderPage();
  const base = await row("base_path");
  expect(within(base).getByText("tenant-a")).toBeTruthy();
  expect(await within(base).findByText("Nothing")).toBeTruthy();
  expect(
    within(base).queryByRole("button", { name: "Undo base_path" }),
  ).toBeNull();
  const crm = await row("crm_token");
  expect(within(crm).getByText("Secret")).toBeTruthy();
  const orders = await within(crm).findByRole("link", { name: "Orders" });
  expect(orders.getAttribute("href")).toBe("/workflows/wf-1");
  expect(within(crm).getByText("· r3")).toBeTruthy();
  expect(
    within(crm).getByRole("link", { name: "CRM" }).getAttribute("href"),
  ).toBe("/upstreams/u-1");
  expect(within(crm).getByText("· v2")).toBeTruthy();
  expect(
    within(crm).getByRole("button", { name: "Undo crm_token" }),
  ).toBeTruthy();
});

test("an empty list says what a constant is for", async () => {
  answer([]);
  renderPage();
  expect(await screen.findByText(/^No constants yet\./)).toBeTruthy();
});

// New constant checks a name as the server does, sends what it's given,
// and says under the name when one has it already.
test("New constant makes one, and says when the name is taken", async () => {
  const list = answer();
  const made: CreateConstant[] = [];
  server.use(
    http.post<PathParams, CreateConstant>(
      "/api/v1/constants",
      async ({ request }) => {
        const body = await request.json();
        made.push(body);
        if (body.name === "base_path")
          return HttpResponse.json(
            { status: 409, code: "conflict", detail: "taken" },
            {
              status: 409,
              headers: { "Content-Type": "application/problem+json" },
            },
          );
        list.push(constant({ ...body, secret: !!body.secret }));
        return HttpResponse.json<Constant>(constant(body), { status: 201 });
      },
    ),
  );
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "New constant" }));
  const dialog = await screen.findByRole("dialog", { name: "New constant" });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "CRM token" },
  });
  fireEvent.change(within(dialog).getByLabelText("Value"), {
    target: { value: "sk_live_1" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
  expect(
    await within(dialog).findByText(/^A lower-case letter, then/),
  ).toBeTruthy();
  expect(made).toHaveLength(0);

  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "base_path" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
  expect(
    await within(dialog).findByText("A constant already has that name."),
  ).toBeTruthy();

  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "crm_key" },
  });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Secret" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "New constant" })).toBeNull(),
  );
  expect(made.at(-1)).toEqual({
    name: "crm_key",
    value: "sk_live_1",
    secret: true,
  });
  // The list is asked again, and has it.
  expect(within(await row("crm_key")).getByText("Secret")).toBeTruthy();
});

// Change starts from a plain constant's value, and can make it secret; a
// secret one starts empty, and has nothing to make secret.
test("Change sends the new value, and makes a plain one secret if asked", async () => {
  const list = answer();
  const sent: { name: string; body: SetConstant }[] = [];
  server.use(
    http.put<{ name: string }, SetConstant>(
      "/api/v1/constants/:name",
      async ({ params, request }) => {
        const body = await request.json();
        sent.push({ name: params.name, body });
        const i = list.findIndex((c) => c.name === params.name);
        list[i] = constant({ name: params.name, secret: true });
        return HttpResponse.json<Constant>(list[i]);
      },
    ),
  );
  renderPage();
  fireEvent.click(
    within(await row("base_path")).getByRole("button", {
      name: "Change base_path",
    }),
  );
  let dialog = await screen.findByRole("dialog", { name: "Change base_path" });
  const value = within(dialog).getByLabelText("Value");
  expect(value).toHaveProperty("value", "tenant-a");
  fireEvent.change(value, { target: { value: "tenant-b" } });
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "Make it secret" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Change" }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    name: "base_path",
    body: { value: "tenant-b", secret: true },
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Change base_path" }),
    ).toBeNull(),
  );
  // The list is asked again: it's secret now.
  expect(
    await within(await row("base_path")).findByText("Secret"),
  ).toBeTruthy();

  fireEvent.click(
    within(await row("crm_token")).getByRole("button", {
      name: "Change crm_token",
    }),
  );
  dialog = await screen.findByRole("dialog", { name: "Change crm_token" });
  expect(within(dialog).getByLabelText("New value")).toHaveProperty(
    "value",
    "",
  );
  expect(
    within(dialog).queryByRole("checkbox", { name: "Make it secret" }),
  ).toBeNull();
});

test("Undo puts the value before back", async () => {
  const list = answer([
    constant({ name: "base_path", value: "tenant-b", has_previous: true }),
  ]);
  server.use(
    http.post<{ name: string }>(
      "/api/v1/constants/:name/undo",
      ({ params }) => {
        list[0] = constant({
          name: params.name,
          value: "tenant-a",
          has_previous: true,
        });
        return HttpResponse.json<Constant>(list[0]);
      },
    ),
  );
  renderPage();
  const base = await row("base_path");
  expect(within(base).getByText("tenant-b")).toBeTruthy();
  fireEvent.click(within(base).getByRole("button", { name: "Undo base_path" }));
  expect(await within(base).findByText("tenant-a")).toBeTruthy();
});

// Archive asks again; refused while something reads the constant, it says
// what, and can't be pressed again (plan 15). Done, the constant moves to
// the Archived tab, and Restore brings it back.
test("Archive asks again, says what reads it, and Restore brings it back", async () => {
  const list = answer();
  const detail = "It's in use, so it can't be archived: Orders at revision 3.";
  const moved = (name: string, to: Partial<Constant>) => {
    const c = list.findIndex((k) => k.name === name);
    list[c] = { ...list[c]!, archived_at: undefined, ...to };
    return HttpResponse.json<Constant>(list[c]);
  };
  server.use(
    http.get("/api/v1/constants", ({ request }) => {
      const archived = new URL(request.url).searchParams.has("archived");
      return HttpResponse.json<ConstantList>({
        constants: list.filter(
          (c) => (c.archived_at !== undefined) === archived,
        ),
      });
    }),
    http.post("/api/v1/constants/crm_token/archive", () =>
      HttpResponse.json(
        { status: 409, code: "in_use", detail },
        {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
    http.post("/api/v1/constants/base_path/archive", () =>
      moved("base_path", { archived_at: at }),
    ),
    http.post("/api/v1/constants/base_path/restore", () =>
      moved("base_path", {}),
    ),
  );
  renderPage();
  fireEvent.click(
    within(await row("crm_token")).getByRole("button", {
      name: "Archive crm_token",
    }),
  );
  let dialog = await screen.findByRole("dialog", {
    name: "Archive crm_token?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
  expect(await within(dialog).findByText(detail)).toBeTruthy();
  expect(
    within(dialog)
      .getByRole("button", { name: "Archive" })
      .matches(":disabled"),
  ).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Archive crm_token?" }),
    ).toBeNull(),
  );
  // Asked again, it starts afresh: the refusal was for the last time.
  fireEvent.click(
    within(await row("crm_token")).getByRole("button", {
      name: "Archive crm_token",
    }),
  );
  dialog = await screen.findByRole("dialog", { name: "Archive crm_token?" });
  expect(within(dialog).queryByText(detail)).toBeNull();
  expect(
    within(dialog)
      .getByRole("button", { name: "Archive" })
      .matches(":disabled"),
  ).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Archive crm_token?" }),
    ).toBeNull(),
  );

  fireEvent.click(
    within(await row("base_path")).getByRole("button", {
      name: "Archive base_path",
    }),
  );
  dialog = await screen.findByRole("dialog", { name: "Archive base_path?" });
  expect(
    within(dialog).getByText(
      "Nothing can read it any more. Its value stays sealed, and Restore brings it back.",
    ),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
  // The list is asked again, and it's left: looked for hidden too, as the
  // page is hidden from a screen reader while the dialog closes.
  await waitFor(() =>
    expect(
      screen.queryByRole("cell", { name: "base_path", hidden: true }),
    ).toBeNull(),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull(),
  );

  fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
  const archived = await row("base_path");
  expect(within(archived).getByText("tenant-a")).toBeTruthy();
  expect(
    within(archived).queryByRole("button", { name: /Archive/ }),
  ).toBeNull();
  expect(within(archived).queryByRole("button", { name: /Change/ })).toBeNull();
  fireEvent.click(
    within(archived).getByRole("button", { name: "Restore base_path" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("cell", { name: "base_path" })).toBeNull(),
  );
  fireEvent.click(screen.getByRole("tab", { name: "In use" }));
  expect(await row("base_path")).toBeTruthy();
});

// A constant read at its latest and its published revision is listed at each.
test("Used by lists each revision that reads it", async () => {
  answer();
  server.use(
    http.get("/api/v1/constants/base_path/users", () =>
      HttpResponse.json<ConstantUsers>({
        workflows: [
          { workflow_id: "wf-1", name: "Orders", revision: 1 },
          { workflow_id: "wf-1", name: "Orders", revision: 3 },
        ],
        upstreams: [],
      }),
    ),
  );
  renderPage();
  const base = await row("base_path");
  expect(await within(base).findByText("· r1")).toBeTruthy();
  expect(within(base).getByText("· r3")).toBeTruthy();
});

test("the Archived tab says when there's nothing on it", async () => {
  answer([]);
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Archived" }));
  expect(await screen.findByText(/Nothing archived/)).toBeTruthy();
});

// The two lists are asked for apart, so the Archived tab never shows, even
// for a moment, what's in use.
test("the Archived tab never shows what's in use", async () => {
  answer();
  server.use(
    http.get("/api/v1/constants", ({ request }) =>
      HttpResponse.json<ConstantList>({
        constants: new URL(request.url).searchParams.has("archived")
          ? []
          : constants,
      }),
    ),
  );
  renderPage();
  await row("base_path");
  fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
  expect(screen.queryByRole("cell", { name: "base_path" })).toBeNull();
  expect(await screen.findByText(/Nothing archived/)).toBeTruthy();
});
