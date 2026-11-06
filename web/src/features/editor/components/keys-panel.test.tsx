import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse, type PathParams } from "msw";
import { afterEach, expect, test } from "vitest";

import { KeysPanel } from "@/features/editor/components/keys-panel";
import type { components } from "@/gen/schema";
import { renderEditor } from "@/test/editor";
import { specExample } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type CallerKey = components["schemas"]["CallerKey"];
type CallerKeyList = components["schemas"]["CallerKeyList"];
type CreateKey = components["schemas"]["CreateKey"];
type MadeKey = components["schemas"]["MadeKey"];
type RotateKey = components["schemas"]["RotateKey"];
type RotatedKey = components["schemas"]["RotatedKey"];

shimReactFlow();

const at = "2026-11-05T09:00:00Z";
const later = "2026-11-06T09:00:00Z";
const value = "cnd_" + "A".repeat(43);

const key = (k: Partial<CallerKey> & { id: string; name: string }) =>
  ({
    prefix: `cnd_${k.id}`,
    status: "active",
    provenance: { actor: "token" },
    created_at: at,
    ...k,
  }) satisfies CallerKey;

// CRM sync works and has been used; Mobile app was rotated, its old key
// working for a day more; Billing's was revoked, and Batch's expired.
const keys: CallerKey[] = [
  key({ id: "m2", name: "Mobile app" }),
  key({ id: "c1", name: "CRM sync", last_used_at: at }),
  key({ id: "m1", name: "Mobile app", status: "expiring", expires_at: later }),
  key({ id: "b1", name: "Billing", status: "revoked", revoked_at: at }),
  key({ id: "x1", name: "Batch", status: "expired", expires_at: at }),
];

// answer has the server list keys, from the list it gives back for a
// test's own handlers to change.
function answer(start: CallerKey[] = keys): CallerKey[] {
  const list = [...start];
  server.use(
    http.get("/api/v1/workflows/wf-1/keys", () =>
      HttpResponse.json<CallerKeyList>({ keys: list }),
    ),
  );
  return list;
}

const problem = (status: number, code: string) =>
  HttpResponse.json(
    { status, code, detail: code },
    { status, headers: { "Content-Type": "application/problem+json" } },
  );

// copied is what Copy put on the clipboard, which jsdom doesn't have.
let copied: string[] = [];
function clipboard(works = true) {
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        if (!works) return Promise.reject(new Error("denied"));
        copied.push(text);
        return Promise.resolve();
      },
    },
  });
}
afterEach(() => Reflect.deleteProperty(navigator, "clipboard"));

const renderPanel = () => renderAt(<KeysPanel workflow="wf-1" />);

// item is the row of the key whose first characters are prefix: its
// dialog names them too.
const item = async (prefix: string) =>
  (await screen.findAllByText(`${prefix}…`))
    .map((e) => e.closest("li"))
    .find((li) => li !== null)!;

test("Keys opens the caller keys: those that work, with what each can do, and those stopped", async () => {
  answer();
  renderEditor(specExample);
  fireEvent.click(await screen.findByRole("button", { name: "Keys" }));
  const panel = await screen.findByRole("complementary", {
    name: "Caller keys",
  });
  expect(
    (await within(panel).findByText("Authorization: Bearer <key>")).closest("p")
      ?.textContent,
  ).toBe("A caller sends its key as Authorization: Bearer <key>.");

  const crm = await item("cnd_c1");
  expect(within(crm).getByText("CRM sync")).toBeTruthy();
  expect(crm.textContent).toMatch(/made .* · last used /);
  expect(
    within(crm).getByRole("button", { name: "Rotate CRM sync (cnd_c1…)" }),
  ).toBeTruthy();
  expect(
    within(crm).getByRole("button", { name: "Revoke CRM sync (cnd_c1…)" }),
  ).toBeTruthy();
  // A rotated key works until its expiry: it can still be stopped now.
  const old = await item("cnd_m1");
  expect(old.textContent).toMatch(/rotated, works until .* · never used/);
  expect(within(old).queryByRole("button", { name: /^Rotate/ })).toBeNull();
  expect(
    within(old).getByRole("button", { name: "Revoke Mobile app (cnd_m1…)" }),
  ).toBeTruthy();

  const stopped = within(panel).getByRole("region", { name: "Stopped" });
  expect(within(stopped).getByText("Billing")).toBeTruthy();
  expect((await item("cnd_b1")).textContent).toMatch(/revoked .*/);
  expect((await item("cnd_x1")).textContent).toMatch(/rotated, stopped /);
  expect(within(stopped).queryAllByRole("button")).toHaveLength(0);
  expect(within(stopped).queryByText("CRM sync")).toBeNull();
});

test("an empty list says what to do first", async () => {
  answer([
    key({ id: "b1", name: "Billing", status: "revoked", revoked_at: at }),
  ]);
  renderPanel();
  expect(
    await screen.findByText("No key works yet. Make one for each caller."),
  ).toBeTruthy();
});

// New key names its caller, and shows the key once, to copy; closed, the
// dialog keeps nothing of it.
test("New key makes one for a caller, and shows it once to copy", async () => {
  const list = answer();
  clipboard();
  const made: CreateKey[] = [];
  server.use(
    http.post<PathParams, CreateKey>(
      "/api/v1/workflows/wf-1/keys",
      async ({ request }) => {
        const body = await request.json();
        made.push(body);
        if (body.name === "CRM sync") return problem(409, "conflict");
        const k = key({ id: "n1", name: body.name });
        list.unshift(k);
        return HttpResponse.json<MadeKey>({ key: k, value }, { status: 201 });
      },
    ),
  );
  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: "New key" }));
  const dialog = await screen.findByRole("dialog", { name: "New key" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
  expect(
    await within(dialog).findByText("Give it a name: who calls with it."),
  ).toBeTruthy();
  expect(made).toHaveLength(0);

  const caller = within(dialog).getByLabelText("Caller");
  fireEvent.change(caller, { target: { value: "CRM sync" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
  expect(
    await within(dialog).findByText(
      "An active key of this workflow has that name.",
    ),
  ).toBeTruthy();

  fireEvent.change(caller, { target: { value: "  Billing  " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
  const shown = await within(dialog).findByLabelText("Key for Billing");
  expect(made.at(-1)).toEqual({ name: "Billing" });
  expect(shown).toHaveProperty("value", value);
  expect(within(dialog).getByText(/it isn't shown again/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
  expect(
    await within(dialog).findByRole("button", { name: "Copied" }),
  ).toBeTruthy();
  expect(copied).toEqual([value]);
  // The list is asked again, and has it.
  expect(await screen.findByText("cnd_n1…")).toBeTruthy();

  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "New key" })).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "New key" }));
  const again = await screen.findByRole("dialog", { name: "New key" });
  expect(within(again).getByLabelText("Caller")).toHaveProperty("value", "");
  expect(within(again).queryByText(value)).toBeNull();
  expect(within(again).queryByDisplayValue(value)).toBeNull();
});

test("a copy that fails says how to copy it by hand", async () => {
  answer([]);
  clipboard(false);
  server.use(
    http.post("/api/v1/workflows/wf-1/keys", () =>
      HttpResponse.json<MadeKey>(
        { key: key({ id: "n1", name: "Billing" }), value },
        { status: 201 },
      ),
    ),
  );
  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: "New key" }));
  const dialog = await screen.findByRole("dialog", { name: "New key" });
  fireEvent.change(within(dialog).getByLabelText("Caller"), {
    target: { value: "Billing" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "Copy" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Couldn't copy it. Select it and copy it yourself.",
  );
});

// choose opens a select from the keyboard and presses an option. Base UI
// takes a click with no press before it only on the option highlighted.
async function choose(label: string, option: string) {
  const select = screen.getByRole("combobox", { name: label });
  select.focus();
  fireEvent.keyDown(select, { key: "ArrowDown" });
  const choice = await screen.findByRole("option", { name: option });
  fireEvent.pointerDown(choice);
  fireEvent.click(choice);
}

// Rotate asks when the old key stops, and gives the new one once: it stays
// as the list is asked again, which moves the old key, or changes it. A key
// rotated elsewhere meanwhile is refused, and the dialog says so.
test("Rotate asks when the old key stops, and shows the new key until it's copied", async () => {
  const list = answer();
  clipboard();
  const sent: RotateKey[] = [];
  server.use(
    http.post<{ key: string }, RotateKey>(
      "/api/v1/workflows/wf-1/keys/:key/rotate",
      async ({ params, request }) => {
        const body = await request.json();
        sent.push(body);
        const i = list.findIndex((k) => k.id === params.key);
        const was = list[i]!;
        if (was.status !== "active") return problem(409, "key_not_active");
        const old =
          body.old_expires_in === "now"
            ? { ...was, status: "expired" as const, expires_at: at }
            : { ...was, status: "expiring" as const, expires_at: later };
        const made = key({ id: `${was.id}-new`, name: was.name });
        list.splice(i, 1, made, old);
        return HttpResponse.json<RotatedKey>({ key: made, value, old });
      },
    ),
  );
  renderPanel();

  // Cancelled, nothing is sent, and it opens again as it was first.
  fireEvent.click(
    await screen.findByRole("button", { name: "Rotate CRM sync (cnd_c1…)" }),
  );
  let dialog = await screen.findByRole("dialog", { name: "Rotate CRM sync" });
  await choose("Old key stops", "In 7 days");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Rotate CRM sync" }),
    ).toBeNull(),
  );

  // With a day to change over, the old key works on.
  fireEvent.click(
    screen.getByRole("button", { name: "Rotate CRM sync (cnd_c1…)" }),
  );
  dialog = await screen.findByRole("dialog", { name: "Rotate CRM sync" });
  expect(
    within(dialog).getByRole("combobox", { name: "Old key stops" }).textContent,
  ).toMatch(/^Pick when/);
  const rotate = within(dialog).getByRole("button", { name: "Rotate" });
  expect(rotate.matches(":disabled")).toBe(true);
  await choose("Old key stops", "In a day");
  await waitFor(() => expect(rotate.matches(":disabled")).toBe(false));
  fireEvent.click(rotate);
  expect(
    await within(dialog).findByLabelText("Key for CRM sync"),
  ).toHaveProperty("value", value);
  expect(sent).toEqual([{ old_expires_in: "1d" }]);
  // The list is asked again: the new key, and the old one until its day is
  // up, without Rotate; the new key is still there to copy.
  expect(await screen.findByText("cnd_c1-new…")).toBeTruthy();
  const old = await item("cnd_c1");
  expect(old.textContent).toMatch(/rotated, works until/);
  expect(within(old).queryByRole("button", { name: /^Rotate/ })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Rotate CRM sync" })).toBeTruthy();
  expect(screen.getByLabelText("Key for CRM sync")).toHaveProperty(
    "value",
    value,
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Rotate CRM sync" }),
    ).toBeNull(),
  );

  // Stopped now, the old key moves to the stopped ones; the new one stays.
  fireEvent.click(
    screen.getByRole("button", { name: "Rotate Mobile app (cnd_m2…)" }),
  );
  dialog = await screen.findByRole("dialog", { name: "Rotate Mobile app" });
  await choose("Old key stops", "Now");
  fireEvent.click(within(dialog).getByRole("button", { name: "Rotate" }));
  expect(
    await within(dialog).findByLabelText("Key for Mobile app"),
  ).toBeTruthy();
  expect(sent.at(-1)).toEqual({ old_expires_in: "now" });
  const stopped = await screen.findByRole("region", {
    name: "Stopped",
    hidden: true,
  });
  expect(await within(stopped).findByText("cnd_m2…")).toBeTruthy();
  expect(screen.getByLabelText("Key for Mobile app")).toHaveProperty(
    "value",
    value,
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Rotate Mobile app" }),
    ).toBeNull(),
  );

  // A key rotated elsewhere, after the list was last asked.
  const stale = list.findIndex((k) => k.id === "c1-new");
  list[stale] = { ...list[stale]!, status: "expiring", expires_at: later };
  fireEvent.click(
    screen.getByRole("button", { name: "Rotate CRM sync (cnd_c1-new…)" }),
  );
  dialog = await screen.findByRole("dialog", { name: "Rotate CRM sync" });
  await choose("Old key stops", "In an hour");
  fireEvent.click(within(dialog).getByRole("button", { name: "Rotate" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "It was rotated or revoked already.",
  );
  expect(sent.at(-1)).toEqual({ old_expires_in: "1h" });
});

// Revoke asks again, and the key, stopped, moves down with the others.
test("Revoke asks again, and stops the key", async () => {
  const list = answer();
  const revoked: string[] = [];
  server.use(
    http.post<{ key: string }>(
      "/api/v1/workflows/wf-1/keys/:key/revoke",
      ({ params }) => {
        revoked.push(params.key);
        const i = list.findIndex((k) => k.id === params.key);
        list[i] = { ...list[i]!, status: "revoked", revoked_at: later };
        return HttpResponse.json<CallerKey>(list[i]);
      },
    ),
  );
  renderPanel();
  fireEvent.click(
    await screen.findByRole("button", { name: "Revoke Mobile app (cnd_m1…)" }),
  );
  let dialog = await screen.findByRole("dialog", {
    name: "Revoke Mobile app?",
  });
  expect(within(dialog).getByText("cnd_m1…")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Revoke Mobile app?" }),
    ).toBeNull(),
  );
  expect(revoked).toHaveLength(0);

  fireEvent.click(
    screen.getByRole("button", { name: "Revoke Mobile app (cnd_m1…)" }),
  );
  dialog = await screen.findByRole("dialog", { name: "Revoke Mobile app?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(revoked).toEqual(["m1"]));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Revoke Mobile app?" }),
    ).toBeNull(),
  );
  // Asked again, it's stopped: looked for hidden too, as the page is
  // hidden from a screen reader while the dialog closes.
  const stopped = await screen.findByRole("region", {
    name: "Stopped",
    hidden: true,
  });
  await waitFor(() =>
    expect(
      within(stopped).getByText("cnd_m1…").closest("li")?.textContent,
    ).toMatch(/revoked /),
  );
});
