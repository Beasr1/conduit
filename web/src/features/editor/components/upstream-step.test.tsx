import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { workflowRevision } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type Revision = components["schemas"]["Revision"];
type Upstream = components["schemas"]["Upstream"];
type UpstreamVersion = components["schemas"]["UpstreamVersion"];
type UpstreamList = components["schemas"]["UpstreamList"];
type CreateUpstream = components["schemas"]["CreateUpstream"];
type Preview = components["schemas"]["Preview"];
type Validation = components["schemas"]["Validation"];
type WorkflowList = components["schemas"]["WorkflowList"];
type WorkflowRevision = components["schemas"]["WorkflowRevision"];

shimReactFlow();

// users is version 2 of the Users API: a user by id, with a 404.
const users: Upstream = {
  parameters: [{ name: "user_id" }],
  request: {
    method: "GET",
    url: "https://users.example.com/v1/users/{{ user_id }}",
  },
  outputs: [{ status: 404 }],
  sample: { body: { id: "7" } },
};

// using has user use it, pinned to version 2.
const using: Definition = {
  nodes: [
    {
      id: "user",
      kind: "http",
      uses: { upstream: "u-1", version: 2 },
      with: { user_id: "input.user_id" },
      unhandled: { fail: true },
    },
  ],
};

const at = "2026-11-02T00:00:00Z";

function version(
  definition: Upstream,
  n: number,
  latest = n,
  name = "Users API",
  id = "u-1",
): UpstreamVersion {
  return {
    upstream: { id, name, latest_version: latest, created_at: at },
    version: n,
    definition,
    provenance: { actor: "token" },
    created_at: at,
  };
}

// library has the server answer for the Users API at its latest version,
// and each version asked for.
function library(latest: UpstreamVersion, ...others: UpstreamVersion[]) {
  server.use(
    http.get("/api/v1/upstreams/u-1", () => HttpResponse.json(latest)),
    http.get("/api/v1/upstreams/u-1/versions/:version", ({ params }) => {
      const v = [latest, ...others].find(
        (x) => String(x.version) === params.version,
      );
      return v
        ? HttpResponse.json(v)
        : HttpResponse.json({ code: "not_found" }, { status: 404 });
    }),
  );
}

// saves keeps each draft the editor saves.
function saves(): Definition[] {
  const saved: Definition[] = [];
  server.use(
    http.put<PathParams, Definition, Revision>(
      "/api/v1/workflows/wf-1/draft",
      async ({ request }) => {
        const draft = await request.json();
        saved.push(draft);
        const { revision } = workflowRevision("wf-1", "Upstreams", draft);
        return HttpResponse.json<Revision>({ ...revision, revision: 2 });
      },
    ),
  );
  return saved;
}

// choose opens a select from the keyboard and presses an option, once
// what it offers is there: the library's upstreams arrive after it opens,
// ahead of New upstream, so where the highlight is can't be counted on.
// Base UI takes a click with no press before it only on the option
// highlighted, so the press comes first, as a mouse's does.
async function choose(label: string, option: string) {
  const select = screen.getByRole("combobox", { name: label });
  select.focus();
  fireEvent.keyDown(select, { key: "ArrowDown" });
  const item = await screen.findByRole("option", { name: option });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
}

async function openStep(id: string) {
  fireEvent.click(
    within(await screen.findByTestId(`rf__node-${id}`)).getByText(id),
  );
  return screen.findByRole("complementary", { name: "HTTP step" });
}

// line is the part of a step's panel that says what the step uses.
const line = (panel: HTMLElement, name = "Upstream") =>
  within(panel).getByRole("region", { name });

// A step that uses an upstream shows what it owns (plan 07): which upstream
// at which version, with its call; the values it gives the parameters; and
// each response's sample to read, with where it leads. The upstream itself
// is changed on its page, which Open upstream opens in a new tab, so the
// draft stays as it is.
test("a step that uses an upstream shows what it owns, and opens the upstream in a new tab", async () => {
  library(version(users, 2));
  const sampled: Upstream = {
    ...users,
    sample: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: "7" },
    },
  };
  renderEditor(using, [], { "u-1@2": sampled });
  const card = await screen.findByTestId("rf__node-user");
  expect(await within(card).findByText("Users API · v2")).toBeTruthy();
  expect(within(card).getByText("404")).toBeTruthy();
  expect(within(card).queryByText("+ Add")).toBeNull();
  const panel = await openStep("user");
  const upstream = line(panel);
  expect(await within(upstream).findByText("Users API")).toBeTruthy();
  expect(within(upstream).getByText("· v2")).toBeTruthy();
  expect(within(upstream).getByText(`GET ${users.request.url}`)).toBeTruthy();
  const open = within(upstream).getByRole("link", {
    name: "Open upstream, opens in a new tab",
  });
  expect(open.getAttribute("href")).toBe("/upstreams/u-1");
  expect(open.getAttribute("target")).toBe("_blank");
  expect(
    within(panel).queryByRole("button", { name: "Edit upstream" }),
  ).toBeNull();
  // One row of tabs, open on its Parameters: no Request, which they
  // preview, and no + Response, as its responses are the upstream's.
  expect(within(panel).queryByRole("tablist", { name: "Request" })).toBeNull();
  expect(within(panel).queryByRole("tab", { name: "Request" })).toBeNull();
  expect(
    within(panel).queryByRole("tab", { name: "Add a response" }),
  ).toBeNull();
  expect(
    within(panel)
      .getByRole("tab", { name: "Parameters" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  // It's in the library already.
  expect(
    within(panel).queryByRole("button", { name: "Save as upstream" }),
  ).toBeNull();
  // Its samples are the upstream's, to read, and one it lacks is added on
  // its page.
  fireEvent.click(within(panel).getByRole("tab", { name: "2xx" }));
  expect(screen.queryByLabelText("2xx body")).toBeNull();
  const ok = screen.getByRole("tabpanel", { name: "2xx" });
  expect(within(ok).getByText("When it answers 2xx")).toBeTruthy();
  expect(within(ok).getByText(/"id": "7"/)).toBeTruthy();
  expect(within(ok).getByText("200")).toBeTruthy();
  expect(
    within(ok).getByText(/"content-type": "application\/json"/),
  ).toBeTruthy();
  fireEvent.click(within(panel).getByRole("tab", { name: "404" }));
  expect(
    within(screen.getByRole("tabpanel", { name: "404" })).getByText(
      "No sample. Add one on the upstream's page.",
    ),
  ).toBeTruthy();

  fireEvent.click(within(panel).getByRole("tab", { name: "Parameters" }));
  const value = screen.getByLabelText("user_id", { selector: "textarea" });
  expect(value).toHaveProperty("value", "input.user_id");
  // A value typed keeps the tab open.
  fireEvent.change(value, { target: { value: "input.id" } });
  expect(
    within(panel)
      .getByRole("tab", { name: "Parameters" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

// Its parameters preview the request the step sends, with the values they
// take, which is why the upstream's request isn't shown as well.
test("a step that uses an upstream previews the request its parameters make", async () => {
  library(version(users, 2));
  renderEditor(using, [], { "u-1@2": users });
  server.use(
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: { user_id: "7" }, nodes: {} },
        parameters: { user_id: "7" },
        sends: {
          method: "GET",
          url: "https://users.example.com/v1/users/7",
          headers: {},
        },
        skipped: false,
        problems: [],
      }),
    ),
  );
  const panel = await openStep("user");
  const sends = await within(panel).findByRole("heading", { name: "Sends" });
  expect(
    within(sends.closest("section")!).getByText(
      "GET https://users.example.com/v1/users/7",
    ),
  ).toBeTruthy();
});

test("a newer version is offered, and taking it keeps the values of the parameters it still has", async () => {
  const v3: Upstream = {
    parameters: [{ name: "user_id" }, { name: "fields" }],
    request: {
      method: "GET",
      url: "https://users.example.com/v3/{{ user_id }}",
    },
  };
  library(version(v3, 3), version(users, 2, 3));
  const saved = saves();
  renderEditor(using, [], { "u-1@2": users });
  const panel = await openStep("user");
  fireEvent.click(await within(panel).findByRole("button", { name: "Use v3" }));
  expect(await within(panel).findByText("· v3")).toBeTruthy();
  expect(within(line(panel)).getByText(`GET ${v3.request.url}`)).toBeTruthy();
  const card = screen.getByTestId("rf__node-user");
  expect(await within(card).findByText("Users API · v3")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  // Saved, the step names its version and its values; the rest is the
  // version's.
  expect(saved[0]?.nodes[0]).toEqual({
    id: "user",
    kind: "http",
    uses: { upstream: "u-1", version: 3 },
    with: { user_id: "input.user_id" },
    unhandled: { fail: true },
  });
});

test("Use vN says when the version doesn't come", async () => {
  library(version(users, 3), version(users, 2, 3));
  server.use(
    http.get("/api/v1/upstreams/u-1/versions/3", () =>
      HttpResponse.json(
        { status: 404, code: "not_found", detail: "no such version" },
        {
          status: 404,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
  );
  renderEditor(using, [], { "u-1@2": users });
  const panel = await openStep("user");
  fireEvent.click(await within(panel).findByRole("button", { name: "Use v3" }));
  expect(
    await within(line(panel)).findByText("Couldn't get v3. Try again."),
  ).toBeTruthy();
  expect(within(panel).getByText("· v2")).toBeTruthy();
  // Tried again once it's there, it's taken, and the words go.
  library(version(users, 3), version(users, 2, 3));
  fireEvent.click(within(panel).getByRole("button", { name: "Use v3" }));
  expect(await within(panel).findByText("· v3")).toBeTruthy();
  expect(
    within(line(panel)).queryByText("Couldn't get v3. Try again."),
  ).toBeNull();
});

// The upstream is changed on its page, in a tab of its own. Back on this
// one, the step offers the version saved there: the library is asked again
// when the page is seen again.
test("back on the workflow's tab, the step offers the version saved on the upstream's page", async () => {
  library(version(users, 2));
  renderEditor(using, [], { "u-1@2": users });
  const panel = await openStep("user");
  expect(await within(line(panel)).findByText("Users API")).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: "Use v3" })).toBeNull();
  library(version(users, 3), version(users, 2, 3));
  document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  expect(
    await within(panel).findByRole("button", { name: "Use v3" }),
  ).toBeTruthy();
});

// The check is sent the draft as it's saved: a step that uses an upstream
// names its version and its values, and no more.
test("the check is sent a step that uses an upstream stripped", async () => {
  library(version(users, 2));
  renderEditor(using, [], { "u-1@2": users });
  const checked: Definition[] = [];
  server.use(
    http.post<PathParams, Definition, Validation>(
      "/api/v1/validate",
      async ({ request }) => {
        checked.push(await request.json());
        return HttpResponse.json<Validation>({ problems: [] });
      },
    ),
  );
  const panel = await openStep("user");
  fireEvent.click(within(panel).getByRole("tab", { name: "Parameters" }));
  fireEvent.change(screen.getByLabelText("user_id", { selector: "textarea" }), {
    target: { value: "input.id" },
  });
  await waitFor(() => expect(checked.length).toBeGreaterThan(0), {
    timeout: 3000,
  });
  expect(checked.at(-1)?.nodes[0]).toEqual({
    ...using.nodes[0],
    with: { user_id: "input.id" },
  });
});

// A problem in the upstream's own fields, which only a version saved before
// a newer check could have, shows on the line, by Open upstream, its fix;
// the problem list takes the cursor there.
test("a problem in the upstream's own fields shows on the line, where the problem list goes", async () => {
  library(version(users, 2));
  renderEditor(
    using,
    [
      {
        pointer: "/nodes/0/request/url",
        code: "invalid_url",
        detail: "use https",
      },
    ],
    { "u-1@2": users },
  );
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(within(list).getByRole("button", { name: /^user · URL/ }));
  const panel = await screen.findByRole("complementary", {
    name: "HTTP step",
  });
  const upstream = line(panel);
  expect(within(upstream).getByText("Use https.")).toBeTruthy();
  expect(within(panel).getAllByText("Use https.")).toHaveLength(1);
  await waitFor(() => expect(document.activeElement).toBe(upstream));
});

// One in its responses opens its Parameters, as it has no + Response to
// open, with the line above saying it; one about the step as a whole shows
// once, above its id.
test("a problem in what a step uses opens its Parameters, and one in no field shows once", async () => {
  library(version(users, 2));
  renderEditor(
    using,
    [
      {
        pointer: "/nodes/0/outputs",
        code: "invalid_outputs",
        detail: "the responses don't fit",
      },
      { pointer: "/nodes/0", code: "invalid_node", detail: "it can't run" },
    ],
    { "u-1@2": users },
  );
  fireEvent.click(await screen.findByRole("button", { name: "2 problems" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(
    within(list).getByRole("button", { name: /^user · Responses/ }),
  );
  const panel = await screen.findByRole("complementary", {
    name: "HTTP step",
  });
  expect(
    within(panel)
      .getByRole("tab", { name: /^Parameters/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    within(line(panel)).getByText("The responses don't fit."),
  ).toBeTruthy();
  expect(within(panel).getAllByText("It can't run.")).toHaveLength(1);
  expect(within(line(panel)).queryByText("It can't run.")).toBeNull();
});

test("Add HTTP step offers the library, and the step uses the upstream's latest version", async () => {
  library(version(users, 2));
  renderEditor({ nodes: [] });
  // After the editor answers an empty library, so this one wins.
  server.use(
    http.get("/api/v1/upstreams", () =>
      HttpResponse.json<UpstreamList>({
        upstreams: [version(users, 2).upstream],
      }),
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Add HTTP step" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Id"), {
    target: { value: "user" },
  });
  await choose("Upstream", "Users API");
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  expect(
    within(await screen.findByTestId("rf__node-user")).getByText("404"),
  ).toBeTruthy();
});

test("Add HTTP step makes a new upstream from a call, each placeholder a parameter the step gives what it read", async () => {
  let made: CreateUpstream | undefined;
  server.use(
    http.post<PathParams, CreateUpstream, UpstreamVersion>(
      "/api/v1/upstreams",
      async ({ request }) => {
        made = await request.json();
        return HttpResponse.json(
          version(made.definition, 1, 1, made.name, "u-9"),
          { status: 201 },
        );
      },
    ),
    http.get("/api/v1/upstreams/u-9", () =>
      HttpResponse.json(version(made!.definition, 1, 1, made!.name, "u-9")),
    ),
  );
  renderEditor({ nodes: [] });
  fireEvent.click(await screen.findByRole("button", { name: "Add HTTP step" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Id"), {
    target: { value: "user" },
  });
  await choose("Upstream", "New upstream");
  await choose("Method", "POST");
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Users API" },
  });
  fireEvent.change(within(dialog).getByLabelText("URL"), {
    target: { value: "https://users.example.com/v1/users/{{ input.user_id }}" },
  });
  // Its samples: the parameter's, and a 409 besides its 2xx.
  fireEvent.change(within(dialog).getByLabelText("Sample input"), {
    target: { value: '{ "user_id": "7" }' },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Add a response" }),
  );
  fireEvent.change(within(dialog).getByLabelText("Response 2 status"), {
    target: { value: "409" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  const panel = await openStep("user");
  expect(await within(panel).findByText("Users API")).toBeTruthy();
  expect(made).toEqual({
    name: "Users API",
    definition: {
      parameters: [{ name: "user_id", sample: "7" }],
      request: {
        method: "POST",
        url: "https://users.example.com/v1/users/{{ user_id }}",
      },
      outputs: [{ status: 409 }],
    },
  });
  // Its 409 is the upstream's, so the step has the block.
  expect(
    within(screen.getByTestId("rf__node-user")).getByText("409"),
  ).toBeTruthy();
  fireEvent.click(within(panel).getByRole("tab", { name: "Parameters" }));
  expect(
    screen.getByLabelText("user_id", { selector: "textarea" }),
  ).toHaveProperty("value", "input.user_id");
});

// What a new upstream lacks, or the server refuses, shows under its field,
// and the dialog stays open.
test("New upstream says what's missing, and what the server refuses, under its field", async () => {
  const answers = [
    HttpResponse.json(
      { status: 409, code: "conflict", detail: "taken" },
      { status: 409, headers: { "Content-Type": "application/problem+json" } },
    ),
    HttpResponse.json(
      {
        status: 422,
        code: "invalid_upstream",
        detail: "The upstream has problems",
        errors: [
          {
            pointer: "/definition/request/url",
            code: "placeholder_in_host",
            detail: "the host holds a placeholder",
          },
        ],
      },
      { status: 422, headers: { "Content-Type": "application/problem+json" } },
    ),
  ];
  let posts = 0;
  server.use(http.post("/api/v1/upstreams", () => answers[posts++]));
  renderEditor({ nodes: [] });
  fireEvent.click(await screen.findByRole("button", { name: "Add HTTP step" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Id"), {
    target: { value: "user" },
  });
  await choose("Upstream", "New upstream");
  fireEvent.change(within(dialog).getByLabelText("Sample input"), {
    target: { value: "[]" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  expect(await within(dialog).findByText("Give it a name.")).toBeTruthy();
  expect(within(dialog).getByText("Add a URL.")).toBeTruthy();
  expect(
    within(dialog).getByText(
      'A JSON object, with a value for each parameter, such as { "user_id": "7" }.',
    ),
  ).toBeTruthy();
  expect(posts).toBe(0);
  fireEvent.change(within(dialog).getByLabelText("Sample input"), {
    target: { value: "" },
  });

  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Users API" },
  });
  fireEvent.change(within(dialog).getByLabelText("URL"), {
    target: { value: "https://{{ input.host }}/v1" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  expect(
    await within(dialog).findByText("An upstream already has that name."),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  expect(
    await within(dialog).findByText("the host holds a placeholder"),
  ).toBeTruthy();
  expect(posts).toBe(2);
});

// Publish takes only steps that use an upstream (plan 07): a step with a
// request of its own says so by Save as upstream, its fix, and the problem
// list takes the cursor there.
test("a request of its own is a problem shown by Save as upstream", async () => {
  renderEditor(
    {
      nodes: [
        {
          id: "crm",
          kind: "http",
          request: { method: "GET", url: "https://crm.example.com/v1" },
          unhandled: { fail: true },
        },
      ],
    },
    [
      {
        pointer: "/nodes/0/request",
        code: "own_request",
        detail: "it has a request of its own",
      },
    ],
  );
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(within(list).getByRole("button", { name: /^crm · Request/ }));
  const panel = await screen.findByRole("complementary", {
    name: "HTTP step",
  });
  expect(
    within(panel).getByRole("tab", { name: "Request (1 problem)" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(panel).getByRole("button", { name: "Save as upstream" }),
    ),
  );
  expect(
    within(panel).getAllByText(
      "Save it as an upstream: Publish takes only steps that use one.",
    ),
  ).toHaveLength(1);
});

test("a parameter's problem opens the Parameters tab, at the parameter", async () => {
  library(version(users, 2));
  renderEditor(
    { nodes: [{ ...using.nodes[0]!, with: {} }] },
    [
      {
        pointer: "/nodes/0/with/user_id",
        code: "required",
        detail: "give it a value",
      },
    ],
    { "u-1@2": users },
  );
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(
    within(list).getByRole("button", { name: /^user · Parameter “user_id”/ }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByLabelText("user_id", { selector: "textarea" }),
    ),
  );
});

test("Save as upstream moves a step's request into the library, each placeholder a parameter", async () => {
  let made: CreateUpstream | undefined;
  server.use(
    http.post<PathParams, CreateUpstream, UpstreamVersion>(
      "/api/v1/upstreams",
      async ({ request }) => {
        made = await request.json();
        return HttpResponse.json(
          version(made.definition, 1, 1, made.name, "u-9"),
          { status: 201 },
        );
      },
    ),
    http.get("/api/v1/upstreams/u-9", () =>
      HttpResponse.json(version(made!.definition, 1, 1, made!.name, "u-9")),
    ),
  );
  renderEditor({
    nodes: [
      {
        id: "crm",
        kind: "http",
        request: {
          method: "GET",
          url: "https://crm.example.com/v1/contacts/{{ input.contact_id }}",
        },
        unhandled: { fail: true },
      },
    ],
  });
  const panel = await openStep("crm");
  fireEvent.click(
    within(panel).getByRole("button", { name: "Save as upstream" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "CRM" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(await within(panel).findByText("CRM")).toBeTruthy();
  expect(made?.definition).toEqual({
    parameters: [{ name: "contact_id" }],
    request: {
      method: "GET",
      url: "https://crm.example.com/v1/contacts/{{ contact_id }}",
    },
  });
  fireEvent.click(within(panel).getByRole("tab", { name: "Parameters" }));
  expect(
    screen.getByLabelText("contact_id", { selector: "textarea" }),
  ).toHaveProperty("value", "input.contact_id");
});

test("Save as upstream asks for a name, and says when it's taken", async () => {
  let posts = 0;
  server.use(
    http.post("/api/v1/upstreams", () => {
      posts++;
      return HttpResponse.json(
        { status: 409, code: "conflict", detail: "taken" },
        {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        },
      );
    }),
  );
  renderEditor({
    nodes: [
      {
        id: "crm",
        kind: "http",
        request: { method: "GET", url: "https://crm.example.com/v1" },
        unhandled: { fail: true },
      },
    ],
  });
  const panel = await openStep("crm");
  fireEvent.click(
    within(panel).getByRole("button", { name: "Save as upstream" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(await within(dialog).findByText("Give it a name.")).toBeTruthy();
  expect(posts).toBe(0);
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "CRM" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(
    await within(dialog).findByText("An upstream already has that name."),
  ).toBeTruthy();
  expect(
    within(dialog).getByLabelText("Name").getAttribute("aria-invalid"),
  ).toBe("true");
});

// greeter is revision 1 of a workflow: it takes a user_id, required, and
// fields, with a sample of each, and answers 200, or 404.
const greeter: Definition = {
  nodes: [],
  input_schema: {
    type: "object",
    properties: { user_id: { type: "string" }, fields: { type: "string" } },
    required: ["user_id"],
  },
  sample_input: { user_id: "1", fields: "all" },
  response: {
    answers: [
      { status: 200, lines: [{ from: "user" }] },
      { status: 404, lines: [{ from: "user", on: 404 }] },
    ],
  },
};

// calling has greet use greeter, pinned to revision 1.
const calling: Definition = {
  nodes: [
    {
      id: "greet",
      kind: "http",
      uses: { workflow: "w-greeter", revision: 1 },
      with: { user_id: "input.id" },
      unhandled: { fail: true },
    },
  ],
};

const calledGreeter = {
  "wf:w-greeter@1": { name: "Greeter", published: 1, definition: greeter },
};

// served has the server answer for Greeter, serving revision published, and
// each of its revisions, in order.
function served(published: number, ...revisions: Definition[]) {
  server.use(
    http.get("/api/v1/workflows/w-greeter", () => {
      const { workflow, revision } = workflowRevision(
        "w-greeter",
        "Greeter",
        revisions.at(-1),
      );
      return HttpResponse.json<WorkflowRevision>({
        workflow: {
          ...workflow,
          latest_revision: revisions.length,
          published_revision: published,
        },
        revision: { ...revision, revision: revisions.length },
      });
    }),
    http.get(
      "/api/v1/workflows/w-greeter/revisions/:revision",
      ({ params }) => {
        const n = Number(params.revision);
        const d = revisions[n - 1];
        if (!d)
          return HttpResponse.json({ code: "not_found" }, { status: 404 });
        const { revision } = workflowRevision("w-greeter", "Greeter", d);
        return HttpResponse.json<Revision>({ ...revision, revision: n });
      },
    ),
  );
}

// A step that uses a workflow is drawn by its name and revision, and its
// panel says which, opens it, and gives the fields of its input values, in
// place of a request; its responses are the workflow's answers, with no
// samples of its own (plan 07).
test("a step that uses a workflow is drawn by its name, and gives its input's fields values", async () => {
  served(1, greeter);
  const saved = saves();
  renderEditor(calling, [], {}, calledGreeter);
  const card = await screen.findByTestId("rf__node-greet");
  expect(within(card).getByText("Greeter · r1")).toBeTruthy();
  expect(within(card).getByText("404")).toBeTruthy();
  expect(within(card).queryByText("+ Add")).toBeNull();
  const panel = await openStep("greet");
  expect(await within(panel).findByText("Greeter")).toBeTruthy();
  expect(within(panel).getByText("· r1")).toBeTruthy();
  const open = within(line(panel, "Workflow")).getByRole("link", {
    name: "Open workflow, opens in a new tab",
  });
  expect(open.getAttribute("href")).toBe("/workflows/w-greeter");
  expect(open.getAttribute("target")).toBe("_blank");
  expect(
    within(panel).queryByRole("button", { name: "Edit upstream" }),
  ).toBeNull();
  // It serves the revision pinned, so none newer is offered.
  expect(within(panel).queryByRole("button", { name: /^Use r/ })).toBeNull();
  // It sends no request, so its request block opens its Input.
  expect(within(panel).queryByRole("tab", { name: "Request" })).toBeNull();
  expect(
    within(panel)
      .getByRole("tab", { name: "Input" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    screen.getByLabelText("user_id", { selector: "textarea" }),
  ).toHaveProperty("value", "input.id");
  const fields = screen.getByLabelText("fields", { selector: "textarea" });
  expect(fields).toHaveProperty("value", "");
  fireEvent.change(fields, { target: { value: "'name'" } });
  fireEvent.click(within(panel).getByRole("tab", { name: "2xx" }));
  expect(screen.queryByLabelText("2xx body")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  // Saved, it names the revision and its values; its responses are the
  // workflow's.
  expect(saved[0]?.nodes[0]).toEqual({
    id: "greet",
    kind: "http",
    uses: { workflow: "w-greeter", revision: 1 },
    with: { user_id: "input.id", fields: "'name'" },
    unhandled: { fail: true },
  });
});

// Its preview runs the workflow's own: what the step gives it, and the
// answer it gets back.
test("a step that uses a workflow previews what it gives it and gets back", async () => {
  served(1, greeter);
  renderEditor(calling, [], {}, calledGreeter);
  server.use(
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: { id: "7" }, nodes: {} },
        parameters: { user_id: "7" },
        gives: { status: 200, body: { hello: "Ada" } },
        skipped: false,
        problems: [],
      }),
    ),
  );
  const panel = await openStep("greet");
  const gives = await within(panel).findAllByRole("heading", { name: "Gives" });
  const result = gives[0]!.closest("section")!;
  expect(within(result).getByText(/"user_id": "7"/)).toBeTruthy();
  expect(within(result).getByRole("heading", { name: "Gets" })).toBeTruthy();
  expect(within(result).getByText("200")).toBeTruthy();
  expect(within(result).getByText(/"hello": "Ada"/)).toBeTruthy();
});

test("a newer revision is offered, and taking it keeps the values of the fields it still takes", async () => {
  const r2: Definition = {
    nodes: [],
    input_schema: { properties: { user_id: {} } },
    response: {
      answers: [
        { status: 200, lines: [{ from: "user" }] },
        { status: 410, lines: [{ from: "user", on: 410 }] },
      ],
    },
  };
  served(2, greeter, r2);
  const saved = saves();
  renderEditor(
    {
      nodes: [
        { ...calling.nodes[0]!, with: { user_id: "input.id", fields: "'x'" } },
      ],
    },
    [],
    {},
    calledGreeter,
  );
  const panel = await openStep("greet");
  fireEvent.click(await within(panel).findByRole("button", { name: "Use r2" }));
  expect(await within(panel).findByText("· r2")).toBeTruthy();
  const card = screen.getByTestId("rf__node-greet");
  expect(await within(card).findByText("410")).toBeTruthy();
  expect(within(card).getByText("Greeter · r2")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]?.nodes[0]).toEqual({
    id: "greet",
    kind: "http",
    uses: { workflow: "w-greeter", revision: 2 },
    with: { user_id: "input.id" },
    unhandled: { fail: true },
  });
});

// Add HTTP step offers the workflows that serve a revision, but not the one
// being edited, which can't use itself; a step made from one uses the
// revision it serves.
test("Add HTTP step offers published workflows but this one, and the step uses the revision served", async () => {
  served(1, greeter);
  renderEditor({ nodes: [] });
  const at = "2026-11-03T00:00:00Z";
  server.use(
    http.get("/api/v1/workflows", () =>
      HttpResponse.json<WorkflowList>({
        workflows: [
          {
            id: "w-greeter",
            slug: "greeter",
            name: "Greeter",
            latest_revision: 1,
            published_revision: 1,
            created_at: at,
          },
          {
            id: "w-draft",
            slug: "draft",
            name: "Not served",
            latest_revision: 1,
            created_at: at,
          },
          {
            id: "wf-1",
            slug: "spec",
            name: "This one",
            latest_revision: 3,
            published_revision: 3,
            created_at: at,
          },
        ],
      }),
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Add HTTP step" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Id"), {
    target: { value: "greet" },
  });
  // Checked while the list is open: once it's open, all of it is there.
  const select = screen.getByRole("combobox", { name: "Upstream" });
  select.focus();
  fireEvent.keyDown(select, { key: "ArrowDown" });
  const item = await screen.findByRole("option", { name: "Greeter" });
  expect(screen.queryByRole("option", { name: "Not served" })).toBeNull();
  expect(screen.queryByRole("option", { name: "This one" })).toBeNull();
  fireEvent.pointerDown(item);
  fireEvent.click(item);
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  const card = await screen.findByTestId("rf__node-greet");
  expect(within(card).getByText("Greeter · r1")).toBeTruthy();
  expect(within(card).getByText("404")).toBeTruthy();
});

test("an input field's problem opens the Input tab, at the field", async () => {
  served(1, greeter);
  renderEditor(
    { nodes: [{ ...calling.nodes[0]!, with: {} }] },
    [
      {
        pointer: "/nodes/0/with/user_id",
        code: "required",
        detail: "give the input field user_id a value",
      },
    ],
    {},
    calledGreeter,
  );
  fireEvent.click(await screen.findByRole("button", { name: "1 problem" }));
  const list = await screen.findByRole("complementary", { name: "Problems" });
  fireEvent.click(
    within(list).getByRole("button", { name: /^greet · Input “user_id”/ }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByLabelText("user_id", { selector: "textarea" }),
    ),
  );
});
