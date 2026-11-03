import { expect, type Locator, type Page } from "@playwright/test";

import { stack } from "./stack";

// What the browser tests do in the app, as a person would: sign in, find a
// step's card, open its panel, and join its blocks.

export async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("API token").fill(stack.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workflows$/);
}

// step is a step's card on the canvas.
export const step = (page: Page, id: string) =>
  page.getByTestId(`rf__node-${id}`);

// said is a card's second line: what the step calls, or, while a run is
// shown, how it went: "running", "200" as it streams, "200, 12 ms" once
// recorded.
export const said = (page: Page, id: string) =>
  step(page, id).locator("span.text-xs").first();

// inRun is the part of a step's panel that says how it went in the run
// shown, beside what the preview says it would do.
export const inRun = (panel: Locator) =>
  panel.locator("section").filter({
    has: panel.page().getByRole("heading", { name: /^In this run/ }),
  });

// open opens a step's panel by its card, once Fit View has every card in
// sight: an open panel narrows the canvas, so one may be out of it.
export async function open(page: Page, id: string) {
  await page.getByRole("button", { name: "Fit View" }).click();
  await step(page, id).getByText(id, { exact: true }).click();
  const panel = page.getByRole("complementary", { name: "HTTP step" });
  await expect(panel.getByLabel("Id", { exact: true })).toHaveValue(id);
  return panel;
}

// upstreamTab opens the upstream a step uses on its page, in the new tab
// Open upstream opens, as an upstream is changed only there (plan 07).
export async function upstreamTab(panel: Locator): Promise<Page> {
  const opened = panel.page().context().waitForEvent("page");
  await panel.getByRole("link", { name: "Open upstream" }).click();
  const tab = await opened;
  await tab.waitForLoadState();
  return tab;
}

// backFrom closes the upstream's tab and goes back to the editor's. A
// browser tells a page it's seen again, which asks the library again;
// headless Chromium keeps every page visible and tells none, so it's told
// here.
export async function backFrom(tab: Page, page: Page) {
  await tab.close();
  await page.bringToFront();
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
  );
}

// Publish waits until every step's failures are decided (plan 12):
// failsTheRun has them fail the run, and failsInto joins them to an answer,
// which the step's Unhandled then names, as the line is drawn only while
// it's picked.
export async function failsTheRun(panel: Locator) {
  await panel.getByRole("tab", { name: "Unhandled" }).click();
  await panel.getByRole("checkbox", { name: "Fail the run" }).check();
}

export async function failsInto(page: Page, id: string, status: number) {
  const panel = await open(page, id);
  await panel.getByRole("tab", { name: "Unhandled" }).click();
  await panel.getByRole("combobox", { name: "Connect Unhandled to" }).click();
  await page
    .getByRole("option", { name: `Response ${status}`, exact: true })
    .click();
  await expect(step(page, id).locator("[data-part='unhandled']")).toHaveText(
    `Unhandled → ${status}`,
  );
}

// connect joins a step's 2xx, or the response of the tab named, to another
// step, or to an answer, with Connect to in that tab.
export async function connect(
  page: Page,
  from: string,
  to: string,
  tab = "2xx",
) {
  const panel = await open(page, from);
  await panel.getByRole("tab", { name: tab, exact: true }).click();
  await panel.getByRole("combobox", { name: "Connect to" }).click();
  await page.getByRole("option", { name: to, exact: true }).click();
}
