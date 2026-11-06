import { expect, test } from "@playwright/test";

import { keyFor, signIn } from "./editor";
import { stack } from "./stack";

// Plan 06's constants: a secret one made on the Constants page, and a plain
// one through the API. An upstream reads both, the plain one in its path
// and the secret one in a header; served, its run sends each as it is and
// keeps the secret masked. Changed on the page, the plain one is what the
// next run reads, with no Publish, and Undo puts it back.
test("constants: made, read by an upstream, masked in a run, changed and undone", async ({
  page,
}) => {
  const tag = Date.now().toString(36);
  const auth = { Authorization: `Bearer ${stack.token}` };
  const user = `user_${tag}`;
  const token = `token_${tag}`;
  const secret = `sk_live_e2e_${tag}`;
  await signIn(page);

  await page.getByRole("link", { name: "Constants" }).click();
  await page.getByRole("button", { name: "New constant" }).click();
  const made = page.getByRole("dialog", { name: "New constant" });
  await made.getByLabel("Name").fill(token);
  await made.getByLabel("Value").fill(secret);
  await made.getByRole("checkbox", { name: "Secret" }).check();
  await made.getByRole("button", { name: "Make" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: token }).getByText("Secret"),
  ).toBeVisible();
  const plain = await page.request.post("/api/v1/constants", {
    headers: auth,
    data: { name: user, value: "7" },
  });
  expect(plain.status()).toBe(201);

  // An upstream that reads both, and a workflow over it, published.
  const up = await page.request.post("/api/v1/upstreams", {
    headers: auth,
    data: {
      name: `Users ${tag}`,
      definition: {
        request: {
          method: "GET",
          url: `${stack.upstream}/users/{{ $const.${user} }}`,
          headers: { "X-Code": `{{ $const.${token} }}` },
        },
      },
    },
  });
  expect(up.status()).toBe(201);
  const upstream = ((await up.json()) as { upstream: { id: string } }).upstream
    .id;
  const slug = `consts-${tag}`;
  const wf = await page.request.post("/api/v1/workflows", {
    headers: auth,
    data: {
      slug,
      name: slug,
      definition: {
        nodes: [
          {
            id: "user",
            kind: "http",
            uses: { upstream, version: 1 },
            unhandled: { fail: true },
          },
        ],
        response: { answers: [{ status: 200, lines: [{ from: "user" }] }] },
      },
    },
  });
  expect(wf.status()).toBe(201);
  const workflow = ((await wf.json()) as { workflow: { id: string } }).workflow
    .id;
  const published = await page.request.post(
    `/api/v1/workflows/${workflow}/publish`,
    { headers: auth, data: { revision: 1 } },
  );
  expect(published.status()).toBe(200);

  const key = await keyFor(page, workflow);
  const serve = async () => {
    const r = await page.request.post(`/serve/${slug}`, {
      headers: { Authorization: `Bearer ${key}` },
      data: {},
    });
    expect(r.status()).toBe(200);
    return ((await r.json()) as { name: string }).name;
  };
  expect(await serve()).toBe("User 7");

  // What the run kept: the header it sent, the secret masked by its name.
  const runs = (await (
    await page.request.get(`/api/v1/runs?workflow_id=${workflow}`, {
      headers: auth,
    })
  ).json()) as { runs: { id: string }[] };
  const run = await (
    await page.request.get(`/api/v1/runs/${runs.runs[0]!.id}`, {
      headers: auth,
    })
  ).text();
  expect(run).toContain(`[secret ${token}]`);
  expect(run).not.toContain(secret);

  // Changed on the page, the next run reads it, with no Publish; Undo puts
  // it back.
  await page.reload();
  const row = page.getByRole("row").filter({ hasText: user });
  await row.getByRole("button", { name: `Change ${user}` }).click();
  const change = page.getByRole("dialog", { name: `Change ${user}` });
  await change.getByLabel("Value").fill("8");
  await change.getByRole("button", { name: "Change" }).click();
  await expect(row.getByText("8", { exact: true })).toBeVisible();
  expect(await serve()).toBe("User 8");
  await row.getByRole("button", { name: `Undo ${user}` }).click();
  await expect(row.getByText("7", { exact: true })).toBeVisible();
  expect(await serve()).toBe("User 7");
});
