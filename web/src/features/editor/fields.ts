import { z } from "zod";

import type { components } from "@/gen/schema";

// What the step forms edit, next to how the definition holds it.

type Request = components["schemas"]["HTTPRequest"];

// A header or query parameter as a row of a form. Rows have an order and may
// be half filled in; the definition's map has neither.
export interface Pair {
  name: string;
  value: string;
}

export function toPairs(map: Record<string, string> | undefined): Pair[] {
  return Object.entries(map ?? {}).map(([name, value]) => ({ name, value }));
}

// fromPairs is the map the rows say. A row without a name isn't one yet, and
// when two rows share a name the first counts, as the form says.
export function fromPairs(rows: Pair[]): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  for (const { name, value } of rows)
    if (name !== "" && !(name in map)) map[name] = value;
  return Object.keys(map).length > 0 ? map : undefined;
}

// whole reads a whole number typed as text: undefined when there's no text,
// null when it isn't a whole number from min to max.
export function whole(
  text: string,
  min: number,
  max: number,
): number | null | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

type Schema = Record<string, unknown>;

// What a JSON field's text reads as: a value once it's whole, nothing for
// no text, and a reason for text that doesn't count yet.
interface Read<T> {
  value?: T;
  error?: string;
}

// readJSON reads any JSON value typed as text, null included.
export function readJSON(text: string): Read<unknown> {
  if (text.trim() === "") return {};
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { error: `Not JSON yet: ${e instanceof Error ? e.message : e}` };
  }
}

// readSchema reads a JSON Schema typed as text, which is an object.
export function readSchema(text: string): Read<Schema> {
  const { value, error } = readJSON(text);
  if (error !== undefined) return { error };
  if (value === undefined) return {};
  if (!isObject(value)) return { error: "A JSON Schema is an object, in { }." };
  return { value };
}

// readHeaders reads a sample's headers typed as text: an object whose
// values are text.
export function readHeaders(text: string): Read<Record<string, string>> {
  const { value, error } = readJSON(text);
  if (error !== undefined) return { error };
  if (value === undefined) return {};
  if (
    !isObject(value) ||
    Object.values(value).some((v) => typeof v !== "string")
  )
    return { error: "Headers are names and text, in { }." };
  return { value: value as Record<string, string> }; // every value checked above
}

// showJSON is a stored value as the text its field starts with: indented,
// or nothing when there's none.
export function showJSON(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function isObject(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const satisfies readonly Request["method"][];

// The limits schema/workflow.yaml sets; the server checks them again.
const MAX_TIMEOUT_MS = 300_000;
export const MIN_ATTEMPTS = 2;
export const MAX_ATTEMPTS = 5;

// What a timeout and a number of attempts must be, as the form and the
// server's problems say it.
export const TIMEOUT_RULE = `A whole number of milliseconds, from 1 to ${MAX_TIMEOUT_MS}.`;
export const ATTEMPTS_RULE = `A whole number from ${MIN_ATTEMPTS} to ${MAX_ATTEMPTS}.`;

// An http step's request as its form holds it: numbers as the text typed,
// maps as rows.
export interface RequestValues {
  method: Request["method"];
  url: string;
  headers: Pair[];
  query: Pair[];
  timeout: string;
  attempts: string;
  idempotent: boolean;
}

// A map holds a name once, so a row repeating an earlier one's name is the
// one marked.
const rows = (message: string) =>
  z
    .array(z.object({ name: z.string(), value: z.string() }))
    .superRefine((list, ctx) => {
      for (const [i, row] of list.entries())
        if (row.name !== "" && list.findIndex((r) => r.name === row.name) < i)
          ctx.addIssue({ code: "custom", message, path: [i, "name"] });
    });

export const requestSchema = z.object({
  method: z.enum(METHODS),
  url: z.string(),
  headers: rows("Another header has this name."),
  query: rows("Another parameter has this name."),
  timeout: z
    .string()
    .refine((t) => whole(t, 1, MAX_TIMEOUT_MS) !== null, TIMEOUT_RULE),
  attempts: z
    .string()
    .refine(
      (t) => whole(t, MIN_ATTEMPTS, MAX_ATTEMPTS) !== null,
      ATTEMPTS_RULE,
    ),
  idempotent: z.boolean(),
});

export function toRequestValues(r: Request | undefined): RequestValues {
  return {
    method: r?.method ?? "GET",
    url: r?.url ?? "",
    headers: toPairs(r?.headers),
    query: toPairs(r?.query),
    timeout: r?.timeout_ms === undefined ? "" : String(r.timeout_ms),
    attempts: r?.retry ? String(r.retry.attempts) : "",
    idempotent: r?.retry?.idempotent ?? false,
  };
}

// toRequest is the request the form says. A number typed as text counts once
// it's a whole number in range; until then the stored one stays, and the
// form says what's wrong. Nothing typed is eaten on the way, since the field
// keeps its own text. The body isn't the form's: it's edited in Preview, and
// the stored one stays.
export function toRequest(r: Request | undefined, v: RequestValues): Request {
  const timeout = whole(v.timeout, 1, MAX_TIMEOUT_MS);
  const attempts = whole(v.attempts, MIN_ATTEMPTS, MAX_ATTEMPTS);
  return {
    ...r,
    method: v.method,
    url: v.url,
    headers: fromPairs(v.headers),
    query: fromPairs(v.query),
    timeout_ms: timeout === null ? r?.timeout_ms : timeout,
    retry:
      attempts === null
        ? r?.retry
        : attempts === undefined
          ? undefined
          : { attempts, ...(v.idempotent ? { idempotent: true } : {}) },
  };
}
