import type { components } from "@/gen/schema";

type Mask = components["schemas"]["Mask"];

// Masks (plan 17): a value marked on an upstream's parameter or response
// field, or on a workflow's input field, is kept as stars wherever a run
// keeps it. The server masks; the editor marks.

export type MaskKind = "none" | "all" | "start" | "end" | "both";

export const MASK_KINDS: [MaskKind, string][] = [
  ["none", "Not masked"],
  ["all", "All of it"],
  ["start", "Keep the start"],
  ["end", "Keep the end"],
  ["both", "Keep both ends"],
];

// The characters an end keeps until someone says otherwise.
const KEPT = 4;

// kindOf is what mask keeps; none for a value that isn't masked.
export function kindOf(mask: Mask | undefined): MaskKind {
  if (!mask) return "none";
  if (mask.start && mask.end) return "both";
  if (mask.start) return "start";
  if (mask.end) return "end";
  return "all";
}

// maskOf is the mask of kind, keeping what was chosen for an end that stays.
export function maskOf(kind: MaskKind, was?: Mask): Mask | undefined {
  const start = was?.start ?? KEPT;
  const end = was?.end ?? KEPT;
  switch (kind) {
    case "none":
      return undefined;
    case "all":
      return {};
    case "start":
      return { start };
    case "end":
      return { end };
    case "both":
      return { start, end };
  }
}

// A name an expression reads without backticks.
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// fieldsIn is each field of a sample that holds a value, as a masked field
// names it: customer.emirates_id, over each item of an array, a name of other
// characters in backticks. What it offers to mark.
export function fieldsIn(sample: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item, path);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const [k, e] of Object.entries(v)) {
        const name = PLAIN.test(k) ? k : `\`${k}\``;
        walk(e, path === "" ? name : `${path}.${name}`);
      }
      return;
    }
    if (path !== "") out.add(path);
  };
  walk(sample, "");
  return [...out];
}
