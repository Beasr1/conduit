import { expect, test } from "@playwright/test";

import { connect, failsInto, open, said, signIn, step } from "./editor";
import { stack } from "./stack";

// Plan 07's upstreams: one is made in the library from its call, and given
// a 404 on its own page; a step uses it, giving its parameter a value, and
// answers through its responses, run and served; it's edited in place, a
// new version the step then pins; and the library says who uses which
// version.
test("the library: make an upstream, use it from a step, run and serve it, edit it in place", async ({
  page,
}) => {
  const tag = Date.now().toString(36);
  const users = `Users ${tag}`;
  const name = `Uses ${tag}`;
  const slug = `uses-${tag}`;
  await signIn(page);

  // Made from its call and its sample input: the name its URL reads is a
  // parameter, and the input gives it a sample.
  await page.getByRole("link", { name: "Upstreams" }).click();
  await page.getByRole("button", { name: "New upstream" }).click();
  const made = page.getByRole("dialog", { name: "New upstream" });
  await made.getByLabel("Name").fill(users);
  await made.getByLabel("URL").fill(`${stack.upstream}/users/{{ user_id }}`);
  await made
    .getByRole("textbox", { name: "Sample input" })
    .fill('{ "user_id": "7" }');
  await made.getByRole("button", { name: "Make" }).click();
  await expect(page.getByRole("heading", { name: users })).toBeVisible();

  // On its page, the parameter's sample is what its body reads and its
  // request renders; a 404 is added, and saved as version 2.
  await expect(page.getByRole("textbox", { name: "Sample input" })).toHaveValue(
    '{\n  "user_id": "7"\n}',
  );
  await page.getByRole("tab", { name: "Body" }).click();
  await expect(
    page.getByRole("button", { name: "Insert user_id" }),
  ).toBeVisible();
  await expect(page.getByText(`GET ${stack.upstream}/users/7`)).toBeVisible();
  await page.getByRole("tab", { name: "Add a response" }).click();
  const status = page.getByRole("textbox", { name: "Add a response" });
  await status.fill("404");
  await status.press("Enter");
  await page.getByRole("button", { name: "Save version 2" }).click();
  await expect(page.getByText(/^Version 2/)).toBeVisible();

  // A workflow with three answers, the one failures go to first.
  await page.getByRole("link", { name: "Workflows" }).click();
  await page.getByRole("button", { name: "New workflow" }).click();
  const created = page.getByRole("dialog", { name: "New workflow" });
  await created.getByLabel("Name").fill(name);
  await created.getByLabel("Slug").fill(slug);
  await created.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]+$/);
  const response = page.getByRole("complementary", { name: "Response" });
  const answer = response.getByRole("textbox", { name: "Add an answer" });
  for (const a of ["502", "404", "200"]) {
    await page.getByRole("button", { name: "Fit View" }).click();
    await page.getByTestId("rf__node-#response").getByText("+ Add").click();
    await answer.fill(a);
    await answer.press("Enter");
  }

  // Add HTTP step offers the library: the step is drawn from the latest
  // version, its 404 the upstream's, and adds no response of its own.
  await page.getByRole("button", { name: "Add HTTP step" }).click();
  const add = page.getByRole("dialog");
  await add.getByLabel("Id").fill("user");
  await add.getByRole("combobox", { name: "Upstream" }).click();
  await page.getByRole("option", { name: users, exact: true }).click();
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(step(page, "user").locator("[data-part='404']")).toBeVisible();
  await expect(step(page, "user").getByText("+ Add")).toHaveCount(0);

  // It gives the parameter a value, and its request is locked.
  let panel = await open(page, "user");
  await expect(panel.getByText("· v2")).toBeVisible();
  await panel.getByRole("tab", { name: "Parameters" }).click();
  await panel.getByLabel("user_id", { exact: true }).fill("input.user_id");
  await panel.getByRole("tab", { name: "Request" }).click();
  await expect(
    panel.getByRole("textbox", { name: "URL", exact: true }),
  ).toBeDisabled();
  await failsInto(page, "user", 502);
  await connect(page, "user", "Response 404", "404");
  await connect(page, "user", "Response 200");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Revision \d/)).toHaveText(/^Revision 2\b/);
  await expect(page.getByRole("button", { name: /problems?$/ })).toHaveCount(0);

  // Run, it answers through the upstream's responses: 200 for a user, 404
  // for one the upstream doesn't have.
  for (const [id, got] of [
    ["7", 200],
    ["gone", 404],
  ] as const) {
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const run = page.getByRole("dialog", { name: "Run" });
    await run.getByLabel("Input").fill(JSON.stringify({ user_id: id }));
    await run.getByRole("button", { name: "Run", exact: true }).click();
    await expect(run).toBeHidden();
    await expect(said(page, "user")).toHaveText(
      new RegExp(`^${got}, \\d+ ms$`),
    );
    await expect(
      page.getByText(
        new RegExp(
          `^Run of revision 2, started .*: succeeded in .*, answered ${got}$`,
        ),
      ),
    ).toBeVisible();
  }

  // Published, it's served through the version it pins.
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(
    page.getByText(new RegExp(`^Revision 2 is served at .*/serve/${slug}$`)),
  ).toBeVisible();
  const served = await page.request.post(`/serve/${slug}`, {
    headers: { Authorization: `Bearer ${stack.token}` },
    data: { user_id: "7" },
  });
  expect(served.status()).toBe(200);
  expect(await served.json()).toMatchObject({ id: "7", name: "User 7" });

  // Edited in place, the upstream's next version is saved, and the step
  // moves to it; while it's open, the workflow waits.
  await page.getByRole("button", { name: "Close run" }).click();
  panel = await open(page, "user");
  await panel.getByRole("button", { name: "Edit upstream" }).click();
  await expect(
    page.getByText(/Save or discard the upstream first/),
  ).toBeVisible();
  await expect(step(page, "user").getByText("+ Add")).toBeVisible();
  await panel.getByRole("tab", { name: "Request" }).click();
  await panel
    .getByRole("textbox", { name: "URL", exact: true })
    .fill(`${stack.upstream}/users/{{ user_id }}?from=v3`);
  await panel.getByRole("button", { name: "Save upstream" }).click();
  await expect(panel.getByText("· v3")).toBeVisible();
  await expect(
    panel.getByRole("textbox", { name: "URL", exact: true }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  // The header's revision, not the one served.
  await expect(page.getByText(/^Revision 3\b(?! is served)/)).toBeVisible();

  // The library says the workflow uses version 3.
  await page.getByRole("link", { name: "Upstreams" }).click();
  await page.getByRole("link", { name: users }).click();
  const usedBy = page.getByRole("region", { name: "Used by" });
  await expect(usedBy.getByRole("link", { name })).toBeVisible();
  await expect(usedBy).toContainText("v3");
});

// A workflow saved with a request of its own, as steps had before every
// call was an upstream's (plan 07, 2026-11-03): Publish asks for an
// upstream, the problem list takes the cursor to Save as upstream, and that
// moves the request into the library, each placeholder a parameter the
// step gives what it read; then it's published and served.
test("a request of its own: Publish asks for an upstream, and Save as upstream moves it there", async ({
  page,
}) => {
  const tag = Date.now().toString(36);
  const slug = `own-${tag}`;
  const made = await page.request.post("/api/v1/workflows", {
    headers: { Authorization: `Bearer ${stack.token}` },
    data: {
      slug,
      name: slug,
      definition: {
        nodes: [
          {
            id: "user",
            kind: "http",
            unhandled: { fail: true },
            request: {
              method: "GET",
              url: `${stack.upstream}/users/{{ input.user_id }}`,
            },
          },
        ],
        response: { answers: [{ status: 200, lines: [{ from: "user" }] }] },
      },
    },
  });
  expect(made.status()).toBe(201);
  const { workflow } = (await made.json()) as { workflow: { id: string } };

  await signIn(page);
  await page.goto(`/workflows/${workflow.id}`);
  await page.getByRole("button", { name: "1 problem" }).click();
  const problems = page.getByRole("complementary", { name: "Problems" });
  await problems.getByRole("button", { name: /^user · Request/ }).click();
  const panel = page.getByRole("complementary", { name: "HTTP step" });
  const saveAs = panel.getByRole("button", { name: "Save as upstream" });
  await expect(saveAs).toBeFocused();
  await expect(
    panel.getByText(
      "Save it as an upstream: Publish takes only steps that use one.",
    ),
  ).toBeVisible();
  await saveAs.click();
  const dialog = page.getByRole("dialog", { name: "Save as upstream" });
  await dialog.getByLabel("Name").fill(`Users ${tag}`);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByText(`Users ${tag}`)).toBeVisible();
  await panel.getByRole("tab", { name: "Parameters" }).click();
  await expect(panel.getByLabel("user_id", { exact: true })).toHaveValue(
    "input.user_id",
  );
  await expect(page.getByRole("button", { name: /problems?$/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(
    page.getByText(new RegExp(`^Revision 2 is served at .*/serve/${slug}$`)),
  ).toBeVisible();
  const served = await page.request.post(`/serve/${slug}`, {
    headers: { Authorization: `Bearer ${stack.token}` },
    data: { user_id: "7" },
  });
  expect(served.status()).toBe(200);
  expect(await served.json()).toMatchObject({ id: "7", name: "User 7" });
});

// Plan 07's workflows as steps: a published workflow, made through the API,
// is picked in Add HTTP step; the step gives its input a value and answers
// through its answers, its 404 too, run and served.
test("a workflow as a step: pick a published one, give its input, run and serve it", async ({
  page,
}) => {
  const tag = Date.now().toString(36);
  const auth = { Authorization: `Bearer ${stack.token}` };
  const upstream = await page.request.post("/api/v1/upstreams", {
    headers: auth,
    data: {
      name: `Users ${tag}`,
      definition: {
        parameters: [{ name: "user_id" }],
        request: {
          method: "GET",
          url: `${stack.upstream}/users/{{ user_id }}`,
        },
        outputs: [{ status: 404 }],
      },
    },
  });
  expect(upstream.status()).toBe(201);
  const users = ((await upstream.json()) as { upstream: { id: string } })
    .upstream.id;
  const lookup = `Lookup ${tag}`;
  const made = await page.request.post("/api/v1/workflows", {
    headers: auth,
    data: {
      slug: `lookup-${tag}`,
      name: lookup,
      definition: {
        nodes: [
          {
            id: "user",
            kind: "http",
            uses: { upstream: users, version: 1 },
            with: { user_id: "input.user_id" },
            unhandled: { fail: true },
          },
        ],
        input_schema: {
          type: "object",
          required: ["user_id"],
          properties: { user_id: { type: "string" } },
        },
        sample_input: { user_id: "7" },
        response: {
          answers: [
            { status: 404, lines: [{ from: "user", on: 404 }] },
            { status: 200, lines: [{ from: "user" }] },
          ],
        },
      },
    },
  });
  expect(made.status()).toBe(201);
  const { workflow } = (await made.json()) as { workflow: { id: string } };
  const published = await page.request.post(
    `/api/v1/workflows/${workflow.id}/publish`,
    { headers: auth, data: { revision: 1 } },
  );
  expect(published.status()).toBe(200);

  await signIn(page);
  const slug = `calls-${tag}`;
  await page.getByRole("button", { name: "New workflow" }).click();
  const created = page.getByRole("dialog", { name: "New workflow" });
  await created.getByLabel("Name").fill(`Calls ${tag}`);
  await created.getByLabel("Slug").fill(slug);
  await created.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]+$/);
  const response = page.getByRole("complementary", { name: "Response" });
  const answer = response.getByRole("textbox", { name: "Add an answer" });
  for (const a of ["502", "404", "200"]) {
    await page.getByRole("button", { name: "Fit View" }).click();
    await page.getByTestId("rf__node-#response").getByText("+ Add").click();
    await answer.fill(a);
    await answer.press("Enter");
  }

  // Add HTTP step offers it among the workflows: the step is drawn by its
  // name and revision, its 404 the workflow's.
  await page.getByRole("button", { name: "Add HTTP step" }).click();
  const add = page.getByRole("dialog");
  await add.getByLabel("Id").fill("find");
  await add.getByRole("combobox", { name: "Upstream" }).click();
  await page.getByRole("option", { name: lookup, exact: true }).click();
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(step(page, "find").getByText(`${lookup} · r1`)).toBeVisible();
  await expect(step(page, "find").locator("[data-part='404']")).toBeVisible();

  // Its request block opens its Input, which takes the workflow's field.
  const panel = await open(page, "find");
  await expect(panel.getByText("· r1")).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Request" })).toHaveCount(0);
  await panel.getByLabel("user_id", { exact: true }).fill("input.id");
  await failsInto(page, "find", 502);
  await connect(page, "find", "Response 404", "404");
  await connect(page, "find", "Response 200");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Revision \d/)).toHaveText(/^Revision 2\b/);
  await expect(page.getByRole("button", { name: /problems?$/ })).toHaveCount(0);
  // Opened afresh, it's drawn from the revision it pins.
  await page.reload();
  await expect(step(page, "find").getByText(`${lookup} · r1`)).toBeVisible();
  await expect(step(page, "find").locator("[data-part='404']")).toBeVisible();

  // Run, it answers through the workflow's answers.
  for (const [id, got] of [
    ["7", 200],
    ["gone", 404],
  ] as const) {
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const run = page.getByRole("dialog", { name: "Run" });
    await run.getByLabel("Input").fill(JSON.stringify({ id }));
    await run.getByRole("button", { name: "Run", exact: true }).click();
    await expect(run).toBeHidden();
    await expect(said(page, "find")).toHaveText(
      new RegExp(`^${got}, \\d+ ms$`),
    );
    await expect(
      page.getByText(
        new RegExp(
          `^Run of revision 2, started .*: succeeded in .*, answered ${got}$`,
        ),
      ),
    ).toBeVisible();
  }

  // Published, it's served, the workflow it uses run inside the server.
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(
    page.getByText(new RegExp(`^Revision 2 is served at .*/serve/${slug}$`)),
  ).toBeVisible();
  const served = await page.request.post(`/serve/${slug}`, {
    headers: auth,
    data: { id: "7" },
  });
  expect(served.status()).toBe(200);
  expect(await served.json()).toMatchObject({ id: "7", name: "User 7" });
});
