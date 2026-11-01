import { expect, type Locator, type Page, test } from "@playwright/test";

import { stack } from "./stack";

// The spec example, as plan 04's Done builds it: user, then orders and prefs
// side by side, then crm, each against the test upstream. prefs answers
// after a second and a half, so the run can be watched while it's running.
const urls = {
  user: `${stack.upstream}/users/{{ input.user_id }}`,
  orders: `${stack.upstream}/orders?user_id={{ nodes.user.body.id }}`,
  prefs: `${stack.upstream}/prefs/{{ nodes.user.body.id }}?ms=1500`,
  crm: `${stack.upstream}/contacts`,
};
const crmBody =
  "{ 'email': nodes.user.body.email, 'orders': $count(nodes.orders.body.orders), 'language': nodes.prefs.body.language }";
const inputSchema = JSON.stringify({
  type: "object",
  required: ["user_id"],
  properties: { user_id: { type: "string" } },
});

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("API token").fill(stack.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workflows$/);
}

// step is a step's card on the canvas.
const step = (page: Page, id: string) => page.getByTestId(`rf__node-${id}`);

// said is a card's second line: what the step calls, or, while a run is
// shown, how it went: "running", "200" as it streams, "200, 12 ms" once
// recorded.
const said = (page: Page, id: string) =>
  step(page, id).locator("span.text-xs").first();

// inRun is the part of a step's panel that says how it went in the run
// shown, beside what the preview says it would do.
const inRun = (panel: Locator) =>
  panel.locator("section").filter({
    has: panel.page().getByRole("heading", { name: /^In this run/ }),
  });

// open opens a step's panel by its card, once Fit View has every card in
// sight: an open panel narrows the canvas, so one may be out of it.
async function open(page: Page, id: string) {
  await page.getByRole("button", { name: "Fit View" }).click();
  await step(page, id).getByText(id, { exact: true }).click();
  const panel = page.getByRole("complementary", { name: "HTTP step" });
  await expect(panel.getByLabel("Id", { exact: true })).toHaveValue(id);
  return panel;
}

// connect joins a step's 2xx to another step, or to an answer, with
// Connect to in its 2xx tab.
async function connect(page: Page, from: string, to: string) {
  const panel = await open(page, from);
  await panel.getByRole("tab", { name: "2xx" }).click();
  await panel.getByRole("combobox", { name: "Connect to" }).click();
  await page.getByRole("option", { name: to, exact: true }).click();
}

test("the Done flow: build the spec example, save it, run it, see what crm did, publish it", async ({
  page,
}) => {
  const slug = `spec-${Date.now().toString(36)}`;
  await signIn(page);

  await page.getByRole("button", { name: "New workflow" }).click();
  const created = page.getByRole("dialog", { name: "New workflow" });
  await created.getByLabel("Name").fill("Spec example");
  await created.getByLabel("Slug").fill(slug);
  await created.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]+$/);

  // Four HTTP steps, each calling the test upstream; crm's URL waits.
  for (const id of ["user", "orders", "prefs", "crm"] as const) {
    await page.getByRole("button", { name: "Add HTTP step" }).click();
    const add = page.getByRole("dialog");
    await add.getByLabel("Id").fill(id);
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(step(page, id)).toBeVisible();
    if (id === "crm") continue;
    const panel = await open(page, id);
    await panel.getByLabel("URL").fill(urls[id]);
  }
  let panel = await open(page, "crm");
  await panel.getByRole("combobox", { name: "Method" }).click();
  await page.getByRole("option", { name: "POST", exact: true }).click();
  await panel.getByLabel("Request body").fill(crmBody);

  // Four connections, and crm joined to the 200 answer.
  await connect(page, "user", "orders");
  await connect(page, "user", "prefs");
  await connect(page, "orders", "crm");
  await connect(page, "prefs", "crm");
  await page.getByTestId("rf__node-#response").getByText("+ Add").click();
  const response = page.getByRole("complementary", { name: "Response" });
  await response.getByLabel("Add an answer").fill("200");
  await response.getByLabel("Add an answer").press("Enter");
  await connect(page, "crm", "Response 200");
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);

  await page.getByRole("button", { name: "Workflow settings" }).click();
  await page.getByRole("textbox", { name: "Input schema" }).fill(inputSchema);

  // Saved, crm's missing URL is a problem, which the list takes the cursor
  // to; a URL fixes it.
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "1 problem" }).click();
  const problems = page.getByRole("complementary", { name: "Problems" });
  await problems.getByRole("button", { name: /^crm · URL/ }).click();
  panel = page.getByRole("complementary", { name: "HTTP step" });
  const url = panel.getByLabel("URL");
  await expect(url).toBeFocused();
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await expect(panel.getByRole("alert")).toHaveText("Add a URL.");
  await url.fill(urls.crm);
  await expect(page.getByRole("button", { name: /problems?$/ })).toHaveCount(0);
  // Saved again: revision 3, after the one with the problem.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/^Revision \d/)).toHaveText(/^Revision 3\b/);

  // A run, followed on the canvas as it goes: prefs is still running once
  // user and orders have answered, and crm waits for it; then each says
  // how long it took.
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const run = page.getByRole("dialog", { name: "Run" });
  await run.getByLabel("Input").fill('{"user_id": "7"}');
  await run.getByRole("button", { name: "Run", exact: true }).click();
  await expect(said(page, "prefs")).toHaveText("running");
  await expect(said(page, "user")).toHaveText("200");
  await expect(said(page, "orders")).toHaveText("200");
  await expect(said(page, "crm")).toHaveText("waiting");
  await expect(said(page, "prefs")).toHaveText(/^200, \d+ ms$/);
  await expect(said(page, "crm")).toHaveText(/^201, \d+ ms$/);
  await expect(
    page.getByText(
      /^Run of revision 3, started .*: succeeded in .*, answered 200$/,
    ),
  ).toBeVisible();

  // What crm sent, and what it got back.
  panel = await open(page, "crm");
  const sent = inRun(panel);
  await expect(sent.getByText(`POST ${urls.crm}`)).toBeVisible();
  await expect(sent.getByText('"email": "user7@example.com"')).toBeVisible();
  await expect(sent.getByText('"orders": 2')).toBeVisible();
  await panel.getByRole("tab", { name: "2xx" }).click();
  const got = inRun(panel.getByRole("tabpanel", { name: "2xx" }));
  await expect(got.getByRole("heading")).toHaveText(/^In this run it got 201/);
  await expect(got.getByText('"id": "c-1"')).toBeVisible();

  // Published, it's served at the address the header shows, and answers.
  // The header names the address before too, so it waits for the revision
  // served.
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(
    page.getByText(new RegExp(`^Revision 3 is served at .*/serve/${slug}$`)),
  ).toBeVisible();
  const served = await page.request.post(`/serve/${slug}`, {
    headers: { Authorization: `Bearer ${stack.token}` },
    data: { user_id: "7" },
  });
  expect(served.status()).toBe(200);
  expect(await served.json()).toMatchObject({
    id: "c-1",
    email: "user7@example.com",
    orders: 2,
    language: "en",
  });
});

test("a definition made through the API, with no layout, opens laid out", async ({
  page,
}) => {
  const slug = `laid-out-${Date.now().toString(36)}`;
  const get = (url: string) => ({ method: "GET", url });
  const made = await page.request.post("/api/v1/workflows", {
    headers: { Authorization: `Bearer ${stack.token}` },
    data: {
      slug,
      name: slug,
      definition: {
        nodes: ["user", "orders", "prefs", "crm"].map((id) => ({
          id,
          kind: "http",
          request: get(`${stack.upstream}/${id}`),
        })),
        edges: [
          { from: "user", to: "orders" },
          { from: "user", to: "prefs" },
          { from: "orders", to: "crm" },
          { from: "prefs", to: "crm" },
        ],
      },
    },
  });
  expect(made.status()).toBe(201);
  const { workflow } = (await made.json()) as { workflow: { id: string } };

  await signIn(page);
  await page.goto(`/workflows/${workflow.id}`);
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
  const box = async (id: string) => {
    const b = await step(page, id).boundingBox();
    if (!b) throw new Error(`${id} isn't drawn`);
    return b;
  };
  const [user, orders, prefs, crm] = await Promise.all(
    ["user", "orders", "prefs", "crm"].map(box),
  );
  // Left to right, orders and prefs side by side, none on another.
  expect(user!.x).toBeLessThan(orders!.x);
  expect(orders!.x).toBe(prefs!.x);
  expect(Math.abs(orders!.y - prefs!.y)).toBeGreaterThanOrEqual(orders!.height);
  expect(prefs!.x).toBeLessThan(crm!.x);
});
