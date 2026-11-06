import { expect, test } from "@playwright/test";

import { signIn } from "./editor";
import { stack } from "./stack";

// Plan 07's caller keys: one made in the editor's Keys panel is shown once,
// and copied; it serves its workflow, where the API token doesn't, and the
// run says which caller it was. Rotated with an hour to change over, both
// keys serve; the old one revoked, only the new one does, and the old one
// stays listed.
test("caller keys: made and copied, served with, rotated and revoked", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const tag = Date.now().toString(36);
  const auth = { Authorization: `Bearer ${stack.token}` };
  const slug = `keys-${tag}`;
  const made = await page.request.post("/api/v1/workflows", {
    headers: auth,
    data: {
      slug,
      name: slug,
      definition: {
        nodes: [
          {
            id: "hello",
            kind: "transform",
            expr: "{ 'hello': input.who }",
            unhandled: { fail: true },
          },
        ],
        response: { answers: [{ status: 200, lines: [{ from: "hello" }] }] },
      },
    },
  });
  expect(made.status()).toBe(201);
  const workflow = ((await made.json()) as { workflow: { id: string } })
    .workflow.id;
  const published = await page.request.post(
    `/api/v1/workflows/${workflow}/publish`,
    { headers: auth, data: { revision: 1 } },
  );
  expect(published.status()).toBe(200);
  const serve = async (key: string) =>
    (
      await page.request.post(`/serve/${slug}`, {
        headers: { Authorization: `Bearer ${key}` },
        data: { who: "Ada" },
      })
    ).status();

  await signIn(page);
  await page.goto(`/workflows/${workflow}`);
  await page.getByRole("button", { name: "Keys", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Caller keys" });
  await expect(
    panel.getByText("No key works yet. Make one for each caller."),
  ).toBeVisible();

  // Made, shown once, and copied.
  await panel.getByRole("button", { name: "New key" }).click();
  let dialog = page.getByRole("dialog", { name: "New key" });
  await dialog.getByLabel("Caller").fill("CRM sync");
  await dialog.getByRole("button", { name: "Make" }).click();
  const first = await dialog.getByLabel("Key for CRM sync").inputValue();
  expect(first).toMatch(/^cnd_[0-9A-Za-z]{43}$/);
  await dialog.getByRole("button", { name: "Copy" }).click();
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  const firstKey = `CRM sync (${first.slice(0, 8)}…)`;
  await expect(
    panel.getByRole("button", { name: `Rotate ${firstKey}` }),
  ).toBeVisible();

  // It serves its workflow, and the API token doesn't; the run says who
  // called.
  expect(await serve(first)).toBe(200);
  expect(await serve(stack.token)).toBe(401);
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await expect(
    page
      .getByRole("complementary", { name: "Runs" })
      .getByText(`called by ${firstKey}`),
  ).toBeVisible();

  // Rotated with an hour to change over, both keys serve.
  await page.getByRole("button", { name: "Keys", exact: true }).click();
  await panel.getByRole("button", { name: `Rotate ${firstKey}` }).click();
  dialog = page.getByRole("dialog", { name: "Rotate CRM sync" });
  await dialog.getByRole("combobox", { name: "Old key stops" }).click();
  await page.getByRole("option", { name: "In an hour" }).click();
  await dialog.getByRole("button", { name: "Rotate", exact: true }).click();
  const second = await dialog.getByLabel("Key for CRM sync").inputValue();
  await dialog.getByRole("button", { name: "Done" }).click();
  expect(second).toMatch(/^cnd_/);
  expect(second).not.toBe(first);
  expect(await serve(first)).toBe(200);
  expect(await serve(second)).toBe(200);
  await expect(panel.getByText(/rotated, works until/)).toBeVisible();

  // The old key revoked, only the new one serves, and the old one is
  // listed, stopped.
  await panel.getByRole("button", { name: `Revoke ${firstKey}` }).click();
  dialog = page.getByRole("dialog", { name: "Revoke CRM sync?" });
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await serve(first)).toBe(401);
  expect(await serve(second)).toBe(200);
  await expect(
    panel
      .getByRole("region", { name: "Stopped" })
      .getByText(`${first.slice(0, 8)}…`),
  ).toBeVisible();
});
