import { expect, test } from "@playwright/test";

import { keyFor, signIn } from "./editor";
import { stack } from "./stack";

// Plan 17's masked fields. A workflow uses an upstream at version 1. On the
// upstream's page a field of its responses is marked, keeping its end, and
// saved as version 2; in Workflow settings a field of the input is marked.
// Served, the workflow answers every value as it is, and keeps them masked:
// the input's own field, the step's response field by version 2's marks
// though the step pins version 1, and the copy of that value the input had,
// kept before the step met it.
test("masks: marked fields are kept masked, and answered as they are", async ({
  page,
}) => {
  const tag = Date.now().toString(36);
  const auth = { Authorization: `Bearer ${stack.token}` };
  const send = async (method: "post" | "put", path: string, data: unknown) => {
    const r = await page.request[method](path, { headers: auth, data });
    expect(r.status(), `${method} ${path}`).toBeLessThan(300);
    return r.json() as Promise<Record<string, Record<string, string>>>;
  };
  const up = (
    await send("post", "/api/v1/upstreams", {
      name: `Users ${tag}`,
      definition: {
        parameters: [{ name: "user_id" }],
        request: {
          method: "GET",
          url: `${stack.upstream}/users/{{ user_id }}`,
        },
        sample: {
          body: { id: "7", name: "User 7", email: "user7@example.com" },
        },
      },
    })
  ).upstream!.id!;
  const slug = `masks-${tag}`;
  const workflow = (
    await send("post", "/api/v1/workflows", {
      slug,
      name: `Masks ${tag}`,
      definition: {
        nodes: [
          {
            id: "user",
            kind: "http",
            uses: { upstream: up, version: 1 },
            with: { user_id: "input.id" },
            unhandled: { fail: true },
          },
        ],
        response: { answers: [{ status: 200, lines: [{ from: "user" }] }] },
        sample_input: { id: "7", contact: "a@b.example", note: "VIP" },
      },
    })
  ).workflow!.id!;

  await signIn(page);
  await page.goto(`/upstreams/${up}`);
  const fields = page.getByRole("region", { name: "Masked fields" });
  await fields
    .getByRole("combobox", { name: "Add a masked field" })
    .fill("email");
  await fields.getByRole("button", { name: "Add", exact: true }).click();
  await fields.getByRole("combobox", { name: "Mask of email" }).click();
  await page.getByRole("option", { name: "Keep the end" }).click();
  await expect(
    fields.getByRole("spinbutton", {
      name: "Characters kept at the end of email",
    }),
  ).toHaveValue("4");
  await page.getByRole("button", { name: "Save version 2" }).click();
  await expect(page.getByText(/^Version 2\b/)).toBeVisible();

  await page.goto(`/workflows/${workflow}`);
  await page.getByRole("button", { name: "Workflow settings" }).click();
  const input = page.getByRole("region", { name: "Masked input fields" });
  await input
    .getByRole("combobox", { name: "Add a masked field" })
    .fill("note");
  await input.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Revision 2\b/)).toBeVisible();

  await send("post", `/api/v1/workflows/${workflow}/publish`, { revision: 2 });
  const served = await page.request.post(`/serve/${slug}`, {
    headers: { Authorization: `Bearer ${await keyFor(page, workflow)}` },
    data: { id: "7", contact: "user7@example.com", note: "VIP customer" },
  });
  expect(served.status()).toBe(200);
  expect(await served.json()).toEqual({
    id: "7",
    name: "User 7",
    email: "user7@example.com",
  });

  const runs = (await (
    await page.request.get(`/api/v1/runs?workflow_id=${workflow}`, {
      headers: auth,
    })
  ).json()) as { runs: { id: string; trigger: string }[] };
  const id = runs.runs.find((r) => r.trigger === "served")?.id;
  expect(id).toBeDefined();
  const run = (await (
    await page.request.get(`/api/v1/runs/${id}`, { headers: auth })
  ).json()) as {
    input: unknown;
    nodes: { node: string; response?: { body: unknown } }[];
  };
  expect(run.input).toEqual({
    id: "7",
    contact: "*************.com",
    note: "************",
  });
  expect(run.nodes.find((n) => n.node === "user")?.response?.body).toEqual({
    id: "7",
    name: "User 7",
    email: "*************.com",
  });
  expect(JSON.stringify(run)).not.toContain("user7@example.com");
});
