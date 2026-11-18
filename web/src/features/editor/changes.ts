import type { components } from "@/gen/schema";

type Change = components["schemas"]["Change"];

// Words is a change in a line (plan 16): code, an expression, set in the
// code font, then the text after it.
export interface Words {
  code?: string;
  text: string;
}

const when = (t: string) => new Date(t).toLocaleString();

const constantHow = {
  set: "has a new value",
  undone: "is back to its value before",
  made_secret: "was made secret",
};

// wordsOf says what happened, and, for one still active, what waits.
export function wordsOf(c: Change): Words {
  const d = c.detail;
  const active = c.state === "active";
  const key = `Key ${d.name ?? ""}${d.prefix ? ` (${d.prefix}…)` : ""}`;
  switch (c.kind) {
    case "constant_changed":
      return {
        code: `$const.${d.name ?? ""}`,
        text: constantHow[d.how ?? "set"],
      };
    case "upstream_version":
      return {
        text: `${d.name ?? ""} has version ${d.version ?? ""}${active ? ": a step uses an older one" : ""}`,
      };
    case "workflow_published":
      return {
        text: `${d.name ?? ""} serves revision ${d.revision ?? ""}${active ? ": a step uses an older one" : ""}`,
      };
    case "key_rotated":
      return {
        text: `${key} rotated: ${
          active && d.expires_at
            ? `the old one works until ${when(d.expires_at)}`
            : "the old one has stopped"
        }`,
      };
    case "key_made":
      return { text: `${key} made` };
    case "key_revoked":
      return { text: `${key} revoked` };
    case "workflow_archived":
      return {
        text: d.keys
          ? `Archived, its ${d.keys === 1 ? "key" : `${d.keys} keys`} revoked`
          : "Archived",
      };
    case "workflow_restored":
      return { text: "Restored" };
    default:
      return {
        text: `${d.name ?? c.subject_id}: ${c.kind.replaceAll("_", " ")}`,
      };
  }
}

// plainOf is words as one string, for a control's name.
export const plainOf = (w: Words) => (w.code ? `${w.code} ${w.text}` : w.text);

// usedIn is the one thing a change is about that a step uses: an upstream
// or a workflow, by id.
export function usedIn(c: Change): { upstream?: string; workflow?: string } {
  if (c.kind === "upstream_version") return { upstream: c.subject_id };
  if (c.kind === "workflow_published") return { workflow: c.subject_id };
  return {};
}
