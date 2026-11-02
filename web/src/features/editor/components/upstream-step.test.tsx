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
type PreviewRequest = components["schemas"]["PreviewRequest"];
type Validation = components["schemas"]["Validation"];

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

const url = () => screen.getByRole("textbox", { name: "URL" });

// A step that uses an upstream is drawn from its version, and its panel
// says which, gives its parameters values, and keeps the upstream's request
// and responses locked (plan 07).
test("a step that uses an upstream is drawn from its version, its request locked", async () => {
  library(version(users, 2));
  renderEditor(using, [], { "u-1@2": users });
  expect(
    within(await screen.findByTestId("rf__node-user")).getByText("404"),
  ).toBeTruthy();
  const panel = await openStep("user");
  expect(await within(panel).findByText("Users API")).toBeTruthy();
  expect(within(panel).getByText("· v2")).toBeTruthy();
  expect(url()).toHaveProperty("value", users.request.url);
  expect(url().matches(":disabled")).toBe(true);
  expect(
    within(panel).queryByRole("tab", { name: "Add a response" }),
  ).toBeNull();
  // It's in the library already, and its samples are the upstream's.
  expect(
    within(panel).queryByRole("button", { name: "Save as upstream" }),
  ).toBeNull();
  fireEvent.click(within(panel).getByRole("tab", { name: "2xx" }));
  expect(screen.getByLabelText("2xx body").matches(":disabled")).toBe(true);

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

// Its responses are the upstream's, so its card adds none, unless the
// upstream is being edited in place; and its body reads its parameters, with
// the values the preview says they take.
test("a step that uses an upstream adds no responses of its own, and its body reads its parameters", async () => {
  library(version(users, 2));
  renderEditor(using, [], { "u-1@2": users });
  server.use(
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: { user_id: "7" }, nodes: {} },
        parameters: { user_id: "7" },
        skipped: false,
        problems: [],
      }),
    ),
  );
  const card = await screen.findByTestId("rf__node-user");
  expect(within(card).queryByText("+ Add")).toBeNull();
  const panel = await openStep("user");
  fireEvent.click(within(panel).getByRole("tab", { name: "Request" }));
  // Its fields are locked, but not the tabs that open them.
  const body = within(panel).getByRole("tab", { name: "Body" });
  expect(body.matches(":disabled")).toBe(false);
  fireEvent.click(body);
  const box = (
    await within(panel).findByRole("heading", { name: "Parameters" })
  ).closest("section");
  expect(
    await within(box!).findByRole("button", { name: "Insert user_id" }),
  ).toBeTruthy();
  expect(within(box!).queryByRole("button", { name: /input/ })).toBeNull();

  fireEvent.click(
    await within(panel).findByRole("button", { name: "Edit upstream" }),
  );
  expect(await within(card).findByText("+ Add")).toBeTruthy();
  // + Response goes with the edit, and the panel opens on the request.
  fireEvent.click(within(panel).getByRole("tab", { name: "Add a response" }));
  fireEvent.click(within(panel).getByRole("button", { name: "Discard" }));
  await waitFor(() =>
    expect(
      within(panel)
        .getByRole("tab", { name: "Request" })
        .getAttribute("aria-selected"),
    ).toBe("true"),
  );
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
  await waitFor(() => expect(url()).toHaveProperty("value", v3.request.url));

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

test("an upstream edited in place is saved as its next version, which the step then uses", async () => {
  library(version(users, 2));
  let sent: { body: Upstream; ifMatch: string | null } | undefined;
  server.use(
    http.put<PathParams, Upstream, UpstreamVersion>(
      "/api/v1/upstreams/u-1",
      async ({ request }) => {
        sent = {
          body: await request.json(),
          ifMatch: request.headers.get("If-Match"),
        };
        return HttpResponse.json(version(sent.body, 3));
      },
    ),
  );
  renderEditor(using, [], { "u-1@2": users });
  const panel = await openStep("user");
  fireEvent.click(
    await within(panel).findByRole("button", { name: "Edit upstream" }),
  );
  await waitFor(() => expect(url().matches(":disabled")).toBe(false));
  // While it's open, the workflow waits.
  expect(
    await screen.findByText(/Save or discard the upstream first/),
  ).toBeTruthy();
  fireEvent.change(url(), {
    target: { value: "https://users.example.com/v2/users/{{ user_id }}" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Save upstream" }));
  await waitFor(() => expect(within(panel).getByText("· v3")).toBeTruthy());
  expect(sent?.ifMatch).toBe('"2"');
  expect(sent?.body.request.url).toBe(
    "https://users.example.com/v2/users/{{ user_id }}",
  );
  expect(sent?.body.parameters).toEqual([{ name: "user_id" }]);
  expect(url().matches(":disabled")).toBe(true);
});

// While it's open, the preview goes with the upstream as it stands, by the
// step's id, beside the draft, stripped as it's saved.
test("an upstream edited in place is previewed as it stands", async () => {
  library(version(users, 2));
  renderEditor(using, [], { "u-1@2": users });
  const asked: PreviewRequest[] = [];
  server.use(
    http.post<PathParams, PreviewRequest, Preview>(
      "/api/v1/preview",
      async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json<Preview>({
          reads: { input: null, nodes: {} },
          skipped: false,
          problems: [],
        });
      },
    ),
  );
  const panel = await openStep("user");
  fireEvent.click(
    await within(panel).findByRole("button", { name: "Edit upstream" }),
  );
  await waitFor(() => expect(url().matches(":disabled")).toBe(false));
  const v2 = "https://users.example.com/v2/users/{{ user_id }}";
  fireEvent.change(url(), { target: { value: v2 } });
  await waitFor(
    () =>
      expect(asked.map((b) => b.upstreams?.user?.request.url)).toContain(v2),
    { timeout: 3000 },
  );
  const sent = asked.find((b) => b.upstreams?.user?.request.url === v2);
  expect(sent?.upstreams?.user?.parameters).toEqual([{ name: "user_id" }]);
  expect(sent?.definition.nodes[0]).toEqual(using.nodes[0]);
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

test("Save upstream says when another version was saved first", async () => {
  library(version(users, 2));
  server.use(
    http.put("/api/v1/upstreams/u-1", () =>
      HttpResponse.json(
        { status: 412, code: "version_mismatch", detail: "moved on" },
        {
          status: 412,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    ),
  );
  renderEditor(using, [], { "u-1@2": users });
  const panel = await openStep("user");
  fireEvent.click(
    await within(panel).findByRole("button", { name: "Edit upstream" }),
  );
  fireEvent.click(within(panel).getByRole("button", { name: "Save upstream" }));
  expect(
    await within(panel).findByText(/Another version was saved first/),
  ).toBeTruthy();
});

test("Discard puts the version the step pins back", async () => {
  library(version(users, 2));
  renderEditor(using, [], { "u-1@2": users });
  const panel = await openStep("user");
  fireEvent.click(
    await within(panel).findByRole("button", { name: "Edit upstream" }),
  );
  await waitFor(() => expect(url().matches(":disabled")).toBe(false));
  fireEvent.change(url(), {
    target: { value: "https://elsewhere.example.com" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(url().matches(":disabled")).toBe(true));
  expect(url()).toHaveProperty("value", users.request.url);
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
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  const panel = await openStep("user");
  expect(await within(panel).findByText("Users API")).toBeTruthy();
  expect(made).toEqual({
    name: "Users API",
    definition: {
      parameters: [{ name: "user_id" }],
      request: {
        method: "POST",
        url: "https://users.example.com/v1/users/{{ user_id }}",
      },
    },
  });
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
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  expect(await within(dialog).findByText("Give it a name.")).toBeTruthy();
  expect(within(dialog).getByText("Add a URL.")).toBeTruthy();
  expect(posts).toBe(0);

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
