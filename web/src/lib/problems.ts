import type { Problem } from "@/lib/api";

// fieldErrors sorts a problem's errors by form field: the pointer "/slug"
// belongs to the field "slug". An error pointing at no field in fields, or
// at the whole document, is left for the form to show as a whole.
export function fieldErrors<F extends string>(
  problem: Problem | undefined,
  fields: readonly F[],
): { byField: Partial<Record<F, string>>; rest: string[] } {
  const byField: Partial<Record<F, string>> = {};
  const rest: string[] = [];
  for (const e of problem?.errors ?? []) {
    const field = fields.find((f) => tokens(e.pointer)[0] === f);
    if (field === undefined) rest.push(e.detail);
    else byField[field] ??= e.detail;
  }
  return { byField, rest };
}

// tokens is a JSON Pointer's reference tokens, each unescaped as RFC 6901 §4
// says: ~1 is "/", then ~0 is "~". A pointer that doesn't start with "/" is
// the whole document, which has none.
export function tokens(pointer: string): string[] {
  if (!pointer.startsWith("/")) return [];
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
}
