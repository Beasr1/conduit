import { expect, type Page, test } from "@playwright/test";

import { keyFor, open, signIn, step } from "./editor";
import { stack } from "./stack";

// Plan 15's archive, one of each kind. An upstream that a live workflow uses
// and a constant it reads are refused, the dialog naming the workflow.
// Archived, the workflow stops being served at once and opens read-only:
// nothing on its canvas moves, nothing in its panels changes, and its tabs
// still open to read. Then the upstream and the constant go too, each listed
// under Archived, and each comes back with Restore: the workflow with no
// keys, so its old one stays refused and a new one serves.
test("archive: refused while in use, read-only, and restored", async ({
  page,
}) => {
  const tag = Date.now().toString(36);
  const auth = { Authorization: `Bearer ${stack.token}` };
  const post = async (path: string, data: unknown) => {
    const r = await page.request.post(path, { headers: auth, data });
    expect(r.status()).toBeLessThan(300);
    return r.json() as Promise<Record<string, Record<string, string>>>;
  };
  const code = `code_${tag}`;
  const slug = `archive-${tag}`;
  const flow = `Flow ${tag}`;
  const upstream = `Users ${tag}`;
  await post("/api/v1/constants", { name: code, value: "abc" });
  const up = (
    await post("/api/v1/upstreams", {
      name: upstream,
      definition: {
        parameters: [{ name: "user_id" }],
        request: {
          method: "GET",
          url: `${stack.upstream}/users/{{ user_id }}`,
          headers: { "X-Code": `{{ $const.${code} }}` },
        },
      },
    })
  ).upstream!.id!;
  const workflow = (
    await post("/api/v1/workflows", {
      slug,
      name: flow,
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
      },
    })
  ).workflow!.id!;
  await post(`/api/v1/workflows/${workflow}/publish`, { revision: 1 });
  const key = await keyFor(page, workflow);
  const serve = async (with_: string) =>
    (
      await page.request.post(`/serve/${slug}`, {
        headers: { Authorization: `Bearer ${with_}` },
        data: { id: "7" },
      })
    ).status();
  expect(await serve(key)).toBe(200);

  await signIn(page);

  // In use, the upstream and the constant are refused.
  await page.goto(`/upstreams/${up}`);
  await archive(page, upstream);
  await expect(
    page.getByText(
      `It's in use, so it can't be archived: ${flow} at revision 1.`,
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.goto("/constants");
  await archive(page, code);
  await expect(
    page.getByText(
      `It's in use, so it can't be archived: ${flow} at revision 1; the upstream ${upstream} at version 1.`,
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // The workflow goes, and its URL stops answering at once.
  await page.goto(`/workflows/${workflow}`);
  await archive(page, flow);
  const restore = page.getByRole("button", { name: "Restore", exact: true });
  await expect(restore).toBeVisible();
  await expect(page.getByText(/^Nothing is served at /)).toBeVisible();
  expect(await serve(key)).toBe(401);
  for (const name of ["Save", "Run", "Publish", "Add HTTP step"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );

  // Nothing on the canvas moves: a drag on a step pans the canvas instead,
  // and the step stays where it's placed on it.
  const card = step(page, "user");
  const placed = () => card.evaluate((e) => e.style.transform);
  const at = await placed();
  const before = await card.boundingBox();
  await page.mouse.move(before!.x + 40, before!.y + 20);
  await page.mouse.down();
  await page.mouse.move(before!.x + 160, before!.y + 120, { steps: 5 });
  await page.mouse.up();
  expect(await placed()).toBe(at);
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);

  // What's picked opens to read: its tabs work, and its fields don't.
  const panel = await open(page, "user");
  await expect(panel.getByRole("textbox", { name: "user_id" })).toBeDisabled();
  await expect(panel.getByLabel("Id", { exact: true })).toBeDisabled();
  await panel.getByRole("tab", { name: "Unhandled" }).click();
  await expect(panel.getByRole("tab", { name: "Unhandled" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const fails = panel.getByRole("checkbox", { name: "Fail the run" });
  await expect(fails).toBeChecked();
  await fails.click({ force: true });
  await expect(fails).toBeChecked();
  // Delete or Backspace leaves what's picked where it is.
  await card.click();
  await page.keyboard.press("Delete");
  await expect(card).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);

  // With nothing live using them, the upstream and the constant go.
  await page.goto(`/upstreams/${up}`);
  await archive(page, upstream);
  await expect(restore).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "URL", exact: true }),
  ).toBeDisabled();
  // A select that's disabled doesn't open, even clicked.
  const method = page.getByRole("combobox", { name: "Method" });
  await expect(method).toBeDisabled();
  await method.click({ force: true });
  await expect(page.getByRole("option", { name: "POST" })).toHaveCount(0);

  // Nothing reads the constant now, as the upstream's archived too.
  await page.goto("/constants");
  await expect(
    page.getByRole("cell", { name: code, exact: true }),
  ).toBeVisible();
  await archive(page, code);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("cell", { name: code, exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("tab", { name: "Archived" }).click();
  await page.getByRole("button", { name: `Restore ${code}` }).click();
  await expect(page.getByRole("cell", { name: code, exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("tab", { name: "In use" }).click();
  await expect(
    page.getByRole("cell", { name: code, exact: true }),
  ).toBeVisible();

  await page.goto("/upstreams");
  await expect(page.getByRole("link", { name: upstream })).toHaveCount(0);
  await page.getByRole("tab", { name: "Archived" }).click();
  await page.getByRole("link", { name: upstream }).click();
  await restore.click();
  await expect(
    page.getByRole("button", { name: "Save version 2" }),
  ).toBeVisible();

  // The workflow comes back without its keys, so a new one serves.
  await page.goto("/workflows");
  await page.getByRole("tab", { name: "Archived" }).click();
  await page.getByRole("link", { name: flow }).click();
  await restore.click();
  await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
  expect(await serve(key)).toBe(401);
  expect(await serve(await keyFor(page, workflow))).toBe(200);
});

// archive asks to archive what's named, on its page or in its row, and says
// yes; a dialog refused stays open, saying why.
async function archive(page: Page, name: string) {
  await page.getByRole("button", { name: `Archive ${name}` }).click();
  await page
    .getByRole("dialog", { name: `Archive ${name}?` })
    .getByRole("button", { name: "Archive" })
    .click();
}
