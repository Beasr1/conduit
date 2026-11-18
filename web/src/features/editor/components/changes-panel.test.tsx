import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { shimReactFlow } from "@/test/react-flow";
import { server } from "@/test/server";

type Change = components["schemas"]["Change"];
type Definition = components["schemas"]["Definition"];
type Upstream = components["schemas"]["Upstream"];

shimReactFlow();

const at = "2026-11-12T09:00:00Z";

const users: Upstream = {
  parameters: [{ name: "user_id" }],
  request: {
    method: "GET",
    url: "https://users.example.com/v1/users/{{ user_id }}",
  },
};

// using has user use the Users API at version 1.
const using: Definition = {
  nodes: [
    {
      id: "user",
      kind: "http",
      uses: { upstream: "u-1", version: 1 },
      with: { user_id: "input.user_id" },
      unhandled: { fail: true },
    },
  ],
};

const change = (c: Partial<Change> & Pick<Change, "id" | "kind">): Change => ({
  subject: "workflow",
  subject_id: "wf-1",
  detail: {},
  provenance: { actor: "token" },
  created_at: at,
  state: "active",
  ...c,
});

// serveChanges answers the workflow's two lists, the active one and its
// history, from changes, and dismisses as the server does.
function serveChanges(start: Change[]) {
  const all = [...start];
  const dismissed: string[] = [];
  server.use(
    http.get("/api/v1/workflows/wf-1/changes", ({ request }) => {
      const history = new URL(request.url).searchParams.has("history");
      return HttpResponse.json({
        changes: all.filter((c) => (c.state === "active") !== history),
      });
    }),
    http.post(
      "/api/v1/workflows/wf-1/changes/:change/dismiss",
      ({ params }) => {
        const i = all.findIndex((c) => c.id === params.change);
        dismissed.push(String(params.change));
        all[i] = {
          ...all[i]!,
          state: "dismissed",
          dismissed_at: at,
          dismissed_by: { actor: "token" },
        };
        return HttpResponse.json(all[i]);
      },
    ),
    http.get("/api/v1/upstreams/u-1/versions/1", () =>
      HttpResponse.json({
        upstream: {
          id: "u-1",
          name: "Users API",
          latest_version: 2,
          created_at: at,
        },
        version: 1,
        definition: users,
        provenance: { actor: "token" },
        created_at: at,
      }),
    ),
    http.get("/api/v1/upstreams/u-1", () =>
      HttpResponse.json({
        upstream: {
          id: "u-1",
          name: "Users API",
          latest_version: 2,
          created_at: at,
        },
        version: 2,
        definition: users,
        provenance: { actor: "token" },
        created_at: at,
      }),
    ),
  );
  return { dismissed };
}

const versionChange = change({
  id: "c3",
  kind: "upstream_version",
  subject: "upstream",
  subject_id: "u-1",
  detail: { name: "Users API", version: 2 },
});
const constantChange = change({
  id: "c2",
  kind: "constant_changed",
  subject: "constant",
  subject_id: "crm_token",
  detail: { name: "crm_token", how: "set" },
});
const keyMade = change({
  id: "c1",
  kind: "key_made",
  subject: "key",
  subject_id: "k1",
  state: "done",
  detail: { name: "Mobile app", prefix: "cnd_ab12" },
});

// The toolbar says how many changes are active; its panel lists them, then
// the history; one about a step opens it, and Dismiss moves one to the
// history (plan 16).
test("the changes list: active ones first, a step opened, one dismissed", async () => {
  renderEditor(using, [], { "u-1@1": users });
  // After the editor's own answers, so these come first.
  const { dismissed } = serveChanges([versionChange, constantChange, keyMade]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Changes, 2 active" }),
  );
  const panel = await screen.findByRole("complementary", { name: "Changes" });
  const active = within(panel).getByRole("region", { name: "Active" });
  const history = within(panel).getByRole("region", { name: "History" });
  expect(
    await within(active).findByText(
      "Users API has version 2: a step uses an older one",
    ),
  ).toBeTruthy();
  expect(within(active).getByText("$const.crm_token").className).toContain(
    "font-mono",
  );
  expect(
    await within(history).findByText("Key Mobile app (cnd_ab12…) made"),
  ).toBeTruthy();
  expect(within(history).queryByRole("button", { name: /Dismiss/ })).toBeNull();

  fireEvent.click(
    within(active).getByRole("button", {
      name: "Dismiss: $const.crm_token has a new value",
    }),
  );
  await waitFor(() =>
    expect(within(active).queryByText("$const.crm_token")).toBeNull(),
  );
  expect(dismissed).toEqual(["c2"]);
  expect(await within(history).findByText(/dismissed/)).toBeTruthy();
  expect(
    await screen.findByRole("button", { name: "Changes, 1 active" }),
  ).toBeTruthy();

  fireEvent.click(
    within(active).getByRole("button", {
      name: "Users API has version 2: a step uses an older one",
    }),
  );
  expect(
    await screen.findByRole("complementary", { name: "HTTP step" }),
  ).toBeTruthy();
});

test("with nothing active, the toolbar says no number and the panel says so", async () => {
  renderEditor(using, [], { "u-1@1": users });
  // After the editor's own answers, so these come first.
  serveChanges([keyMade]);
  fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
  const panel = await screen.findByRole("complementary", { name: "Changes" });
  expect(await within(panel).findByText("Nothing waits on you.")).toBeTruthy();
});
