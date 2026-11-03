import { expect, test } from "@playwright/test";

import {
  backFrom,
  connect,
  failsInto,
  failsTheRun,
  inRun,
  open,
  said,
  signIn,
  step,
  upstreamTab,
} from "./editor";
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

  // Tour in the toolbar: on an empty canvas, two stops, each beside the
  // part it's about: the response's, left of its card.
  await page.getByRole("button", { name: "Tour" }).click();
  const tour = page.getByRole("dialog");
  await expect(tour.getByText("1 of 2")).toBeVisible();
  await tour.getByRole("button", { name: "Next" }).click();
  await expect(tour.getByText("2 of 2")).toBeVisible();
  const card = page.getByTestId("rf__node-#response");
  await expect
    .poll(async () => {
      const [stop, beside] = [
        await tour.boundingBox(),
        await card.boundingBox(),
      ];
      return !!stop && !!beside && stop.x + stop.width <= beside.x;
    })
    .toBe(true);
  await tour.getByRole("button", { name: "Done" }).click();
  await expect(tour).toBeHidden();

  // Four HTTP steps, each a new upstream calling the test upstream, made in
  // Add HTTP step (plan 07): its URL reads the run, and each placeholder
  // becomes a parameter the step gives what it read. user's and orders'
  // failures fail the run.
  for (const id of ["user", "orders", "prefs", "crm"] as const) {
    await page.getByRole("button", { name: "Add HTTP step" }).click();
    const add = page.getByRole("dialog");
    await add.getByLabel("Id").fill(id);
    await add.getByRole("combobox", { name: "Upstream" }).click();
    await page.getByRole("option", { name: "New upstream" }).click();
    await add.getByLabel("Name", { exact: true }).fill(`${id} ${slug}`);
    if (id === "crm") {
      await add.getByRole("combobox", { name: "Method" }).click();
      await page.getByRole("option", { name: "POST", exact: true }).click();
    }
    await add.getByRole("textbox", { name: "URL", exact: true }).fill(urls[id]);
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(step(page, id)).toBeVisible();
    if (id === "user" || id === "orders")
      await failsTheRun(await open(page, id));
  }

  // crm sends a body. Its upstream is changed on its page, in a new tab,
  // so the draft stays here: it takes a parameter, body, sent as its JSON
  // body, and saves that as its version 2, which the step takes back here;
  // the value it gives body waits.
  let panel = await open(page, "crm");
  const upstream = await upstreamTab(panel);
  await upstream.getByRole("textbox", { name: "Add a parameter" }).fill("body");
  await upstream.getByRole("button", { name: "Add", exact: true }).click();
  await upstream.getByRole("tab", { name: "Body" }).click();
  await upstream.getByRole("textbox", { name: "Request body" }).fill("body");
  await upstream.getByRole("button", { name: "Save version 2" }).click();
  await expect(upstream.getByText(/^Version 2/)).toBeVisible();
  await backFrom(upstream, page);
  await panel.getByRole("button", { name: "Use v2" }).click();
  await expect(panel.getByText("· v2")).toBeVisible();

  // Four connections, and crm joined to the 200 answer.
  await connect(page, "user", "orders");
  await connect(page, "user", "prefs");
  await connect(page, "orders", "crm");
  await connect(page, "prefs", "crm");
  await page.getByTestId("rf__node-#response").getByText("+ Add").click();
  const response = page.getByRole("complementary", { name: "Response" });
  const answer = response.getByRole("textbox", { name: "Add an answer" });
  await answer.fill("200");
  await answer.press("Enter");
  await connect(page, "crm", "Response 200");
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);

  // prefs' and crm's failures go into one answer, 500, moved above the 200,
  // as a run gives the first answer reached (plan 14). Picked, crm's line
  // into it is drawn, and no other.
  await page.getByRole("button", { name: "Fit View" }).click();
  await page.getByTestId("rf__node-#response").getByText("+ Add").click();
  await answer.fill("500");
  await answer.press("Enter");
  await response.getByRole("button", { name: "Move 500 up" }).click();
  await expect(response.getByRole("heading", { level: 4 })).toHaveText([
    /^1\.\s*500/,
    /^2\.\s*200/,
  ]);
  await failsInto(page, "prefs", 500);
  await failsInto(page, "crm", 500);
  await expect(page.locator(".react-flow__edge.link")).toHaveCount(1);
  await open(page, "user");
  await expect(page.locator(".react-flow__edge.link")).toHaveCount(0);

  await page.getByRole("button", { name: "Workflow settings" }).click();
  await page.getByRole("textbox", { name: "Input schema" }).fill(inputSchema);

  // Saved, crm's body has no value yet, a problem, which the list takes the
  // cursor to; its value fixes it.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "1 problem" }).click();
  const problems = page.getByRole("complementary", { name: "Problems" });
  await problems
    .getByRole("button", { name: /^crm · Parameter “body”/ })
    .click();
  panel = page.getByRole("complementary", { name: "HTTP step" });
  const body = panel.getByRole("textbox", { name: "body", exact: true });
  await expect(body).toBeFocused();
  await expect(body).toHaveAttribute("aria-invalid", "true");
  await expect(panel.getByText("Give the parameter a value.")).toBeVisible();
  await body.fill(crmBody);
  await expect(page.getByRole("button", { name: /problems?$/ })).toHaveCount(0);
  // Saved again: revision 3, after the one with the problem.
  await page.getByRole("button", { name: "Save", exact: true }).click();
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
