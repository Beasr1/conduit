import { expect, test } from "@playwright/test";

import { keyFor, signIn } from "./editor";
import { stack } from "./stack";

// Plan 16's changes list. A workflow uses an upstream that reads a constant,
// and has two caller keys. The constant changes, the upstream saves a new
// version, and the keys are rotated, one with an hour to change over and
// one at once: the editor counts three active, the rotation at once going
// straight to the history. Taking up the new version on the step, and
// saving, deals with it; Dismiss moves the constant's to the history; and
// the workflow list counts what's left.
test("changes: what happens to what a workflow uses, dealt with or dismissed", async ({
  page,
}) => {
  const tag = Date.now().toString(36);
  const auth = { Authorization: `Bearer ${stack.token}` };
  const send = async (
    method: "post" | "put",
    path: string,
    data: unknown,
    headers = {},
  ) => {
    const r = await page.request[method](path, {
      headers: { ...auth, ...headers },
      data,
    });
    expect(r.status(), `${method} ${path}`).toBeLessThan(300);
    return r.json() as Promise<Record<string, Record<string, string>>>;
  };
  const code = `code_${tag}`;
  const flow = `Changes ${tag}`;
  const upstream = `Users ${tag}`;
  await send("post", "/api/v1/constants", { name: code, value: "abc" });
  const definition = (query: Record<string, string>) => ({
    parameters: [{ name: "user_id" }],
    request: {
      method: "GET",
      url: `${stack.upstream}/users/{{ user_id }}`,
      headers: { "X-Code": `{{ $const.${code} }}` },
      query,
    },
  });
  const up = (
    await send("post", "/api/v1/upstreams", {
      name: upstream,
      definition: definition({}),
    })
  ).upstream!.id!;
  const workflow = (
    await send("post", "/api/v1/workflows", {
      slug: `changes-${tag}`,
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
  await keyFor(page, workflow);
  await keyFor(page, workflow);
  const keys = (await (
    await page.request.get(`/api/v1/workflows/${workflow}/keys`, {
      headers: auth,
    })
  ).json()) as {
    keys: { id: string }[];
  };

  await signIn(page);
  await page.goto(`/workflows/${workflow}`);
  await expect(
    page.getByRole("button", { name: "Changes", exact: true }),
  ).toBeVisible();

  await send("put", `/api/v1/constants/${code}`, { value: "def" });
  await send("put", `/api/v1/upstreams/${up}`, definition({ v: "2" }), {
    "If-Match": '"1"',
  });
  await send(
    "post",
    `/api/v1/workflows/${workflow}/keys/${keys.keys[0]!.id}/rotate`,
    { old_expires_in: "1h" },
  );
  await send(
    "post",
    `/api/v1/workflows/${workflow}/keys/${keys.keys[1]!.id}/rotate`,
    { old_expires_in: "now" },
  );

  await page.reload();
  await page.getByRole("button", { name: "Changes, 3 active" }).click();
  const panel = page.getByRole("complementary", { name: "Changes" });
  const active = panel.getByRole("region", { name: "Active" });
  const history = panel.getByRole("region", { name: "History" });
  await expect(
    active.getByText(`${upstream} has version 2: a step uses an older one`),
  ).toBeVisible();
  await expect(active.getByText(`$const.${code}`)).toBeVisible();
  await expect(
    active.getByText(/rotated: the old one works until/),
  ).toBeVisible();
  await expect(
    history.getByText(/rotated: the old one has stopped/),
  ).toBeVisible();

  // Taken up on the step and saved, the new version is dealt with.
  await active
    .getByRole("button", {
      name: `${upstream} has version 2: a step uses an older one`,
      exact: true,
    })
    .click();
  const step = page.getByRole("complementary", { name: "HTTP step" });
  await step.getByRole("button", { name: "Use v2" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Revision 2\b/)).toBeVisible();
  await page.getByRole("button", { name: "Changes, 2 active" }).click();
  await expect(
    history.getByText(`${upstream} has version 2`, { exact: true }),
  ).toBeVisible();

  // Dismissed, the constant's goes to the history too.
  await active
    .getByRole("button", { name: `Dismiss: $const.${code} has a new value` })
    .click();
  await expect(
    page.getByRole("button", { name: "Changes, 1 active" }),
  ).toBeVisible();
  await expect(history.getByText(/dismissed/)).toBeVisible();

  await page.goto("/workflows");
  await expect(
    page.getByRole("row").filter({ hasText: flow }).getByRole("cell").nth(4),
  ).toHaveText("1");
});
