import { expect, test } from "vitest";

import { plainOf, usedIn, wordsOf } from "@/features/editor/changes";
import type { components } from "@/gen/schema";

type Change = components["schemas"]["Change"];

const at = "2026-11-12T09:00:00Z";
const change = (c: Partial<Change> & Pick<Change, "kind">): Change => ({
  id: "c1",
  subject: "workflow",
  subject_id: "x",
  detail: {},
  provenance: { actor: "token" },
  created_at: at,
  state: "done",
  ...c,
});

// Each kind of change in a line, an expression in the code font, and what
// still waits said only while it does (plan 16).
test("each change is said in a line", () => {
  const until = new Date(at).toLocaleString();
  const cases: [Change, string, string?][] = [
    [
      change({
        kind: "constant_changed",
        state: "active",
        detail: { name: "crm_token", how: "set" },
      }),
      "has a new value",
      "$const.crm_token",
    ],
    [
      change({
        kind: "constant_changed",
        detail: { name: "crm_token", how: "undone" },
      }),
      "is back to its value before",
      "$const.crm_token",
    ],
    [
      change({
        kind: "constant_changed",
        detail: { name: "crm_token", how: "made_secret" },
      }),
      "was made secret",
      "$const.crm_token",
    ],
    [
      change({
        kind: "upstream_version",
        state: "active",
        detail: { name: "Users API", version: 4 },
      }),
      "Users API has version 4: a step uses an older one",
    ],
    [
      change({
        kind: "upstream_version",
        detail: { name: "Users API", version: 4 },
      }),
      "Users API has version 4",
    ],
    [
      change({
        kind: "workflow_published",
        state: "active",
        detail: { name: "Billing", revision: 5 },
      }),
      "Billing serves revision 5: a step uses an older one",
    ],
    [
      change({
        kind: "key_rotated",
        state: "active",
        detail: { name: "Mobile app", prefix: "cnd_ab12", expires_at: at },
      }),
      `Key Mobile app (cnd_ab12…) rotated: the old one works until ${until}`,
    ],
    [
      change({
        kind: "key_rotated",
        detail: { name: "Mobile app", prefix: "cnd_ab12", expires_at: at },
      }),
      "Key Mobile app (cnd_ab12…) rotated: the old one has stopped",
    ],
    [
      change({
        kind: "key_made",
        detail: { name: "Billing", prefix: "cnd_cd34" },
      }),
      "Key Billing (cnd_cd34…) made",
    ],
    [
      change({
        kind: "key_revoked",
        detail: { name: "Billing", prefix: "cnd_cd34" },
      }),
      "Key Billing (cnd_cd34…) revoked",
    ],
    [
      change({
        kind: "workflow_archived",
        detail: { name: "Orders", keys: 2 },
      }),
      "Archived, its 2 keys revoked",
    ],
    [
      change({
        kind: "workflow_archived",
        detail: { name: "Orders", keys: 1 },
      }),
      "Archived, its key revoked",
    ],
    [
      change({ kind: "workflow_archived", detail: { name: "Orders" } }),
      "Archived",
    ],
    [
      change({ kind: "workflow_restored", detail: { name: "Orders" } }),
      "Restored",
    ],
  ];
  for (const [c, text, code] of cases) {
    const w = wordsOf(c);
    expect(w.text).toBe(text);
    expect(w.code).toBe(code);
  }
  expect(plainOf(wordsOf(cases[0]![0]))).toBe(
    "$const.crm_token has a new value",
  );
});

test("only a newer version or revision is about what a step uses", () => {
  expect(
    usedIn(change({ kind: "upstream_version", subject_id: "u-1" })),
  ).toEqual({ upstream: "u-1" });
  expect(
    usedIn(change({ kind: "workflow_published", subject_id: "w-1" })),
  ).toEqual({ workflow: "w-1" });
  expect(
    usedIn(change({ kind: "constant_changed", subject_id: "crm_token" })),
  ).toEqual({});
});
