import { expect, test } from "vitest";

import {
  fromPairs,
  readHeaders,
  readJSON,
  readSchema,
  showJSON,
  toPairs,
  toRequest,
  toRequestValues,
  whole,
} from "@/features/editor/fields";
import type { components } from "@/gen/schema";

type Request = components["schemas"]["HTTPRequest"];

test("rows come back as the map they started from", () => {
  const headers = { Accept: "application/json", "X-Id": "{{ input.id }}" };
  expect(fromPairs(toPairs(headers))).toEqual(headers);
  expect(toPairs(undefined)).toEqual([]);
});

test("a row without a name isn't written, and a repeated name keeps the first", () => {
  expect(
    fromPairs([
      { name: "", value: "half typed" },
      { name: "Accept", value: "application/json" },
      { name: "Accept", value: "text/plain" },
    ]),
  ).toEqual({ Accept: "application/json" });
  expect(fromPairs([{ name: "", value: "x" }])).toBeUndefined();
});

test.each([
  ["", undefined],
  [" 250 ", 250],
  ["1", 1],
  ["300000", 300000],
  ["0", null],
  ["300001", null],
  ["2.5", null],
  ["30s", null],
  ["-1", null],
])("%j reads as %j", (text, n) => {
  expect(whole(text, 1, 300000)).toBe(n);
});

test.each([
  ["", {}],
  ["null", { value: null }],
  ["[1, 2]", { value: [1, 2] }],
  ['"ada"', { value: "ada" }],
])("JSON text %j reads as %j", (text, read) => {
  expect(readJSON(text)).toEqual(read);
});

test.each([
  ["", {}],
  ['{"Content-Type": "text/csv"}', { value: { "Content-Type": "text/csv" } }],
  ['{"x-count": 2}', { error: "Headers are names and text, in { }." }],
  ["[]", { error: "Headers are names and text, in { }." }],
])("header text %j reads as %j", (text, read) => {
  expect(readHeaders(text)).toEqual(read);
});

test.each([
  ["", {}],
  ['{"type": "object"}', { value: { type: "object" } }],
  ["[]", { error: "A JSON Schema is an object, in { }." }],
  ["null", { error: "A JSON Schema is an object, in { }." }],
])("schema text %j reads as %j", (text, read) => {
  expect(readSchema(text)).toEqual(read);
});

test("half-typed schema text says why it doesn't count yet", () => {
  expect(readSchema('{"type":').error).toMatch(/^Not JSON yet: /);
});

test("a stored value starts its field formatted", () => {
  expect(showJSON({ type: "object" })).toBe('{\n  "type": "object"\n}');
  expect(showJSON(null)).toBe("null");
  expect(showJSON(undefined)).toBe("");
});

const request: Request = {
  method: "POST",
  url: "https://crm.example.com/v1/contacts",
  headers: { Accept: "application/json" },
  body: '{"name": nodes.user.body.name}',
  timeout_ms: 1000,
  retry: { attempts: 3, idempotent: true },
};

test("a request comes back from its form as it was", () => {
  expect(toRequest(request, toRequestValues(request))).toEqual(request);
});

test("a number counts once it's whole and in range, and until then the stored one stays", () => {
  const form = toRequestValues(request);
  const timeout = (t: string) => toRequest(request, { ...form, timeout: t });
  expect(timeout("30s").timeout_ms).toBe(1000);
  expect(timeout("5000").timeout_ms).toBe(5000);
  expect(timeout("").timeout_ms).toBeUndefined();

  const attempts = (a: string, idempotent = true) =>
    toRequest(request, { ...form, attempts: a, idempotent }).retry;
  expect(attempts("9")).toEqual(request.retry);
  expect(attempts("")).toBeUndefined();
  expect(attempts("2", false)).toEqual({ attempts: 2 });
});
