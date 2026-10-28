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
    const field = fields.find((f) => topToken(e.pointer) === f);
    if (field === undefined) rest.push(e.detail);
    else byField[field] ??= e.detail;
  }
  return { byField, rest };
}

// topToken is a JSON Pointer's first reference token, unescaped as RFC 6901
// §4 says: ~1 is "/", then ~0 is "~".
function topToken(pointer: string): string | undefined {
  if (!pointer.startsWith("/")) return undefined;
  const token = pointer.slice(1).split("/")[0] ?? "";
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}
