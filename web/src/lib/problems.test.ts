import { expect, test } from "vitest";

import { fieldErrors } from "@/lib/problems";

test("sorts errors by the field their pointer starts in", () => {
  const { byField, rest } = fieldErrors(
    {
      errors: [
        { pointer: "/slug", code: "invalid_slug", detail: "bad slug" },
        { pointer: "/name", code: "invalid_name", detail: "bad name" },
        { pointer: "/name", code: "too_long", detail: "a second one" },
        {
          pointer: "/definition/nodes/0/id",
          code: "invalid_id",
          detail: "bad id",
        },
        { pointer: "", code: "invalid_json", detail: "the whole body" },
      ],
    },
    ["slug", "name"],
  );
  expect(byField).toEqual({ slug: "bad slug", name: "bad name" });
  expect(rest).toEqual(["bad id", "the whole body"]);
});

test("unescapes ~1, then ~0, as RFC 6901 says", () => {
  const { byField } = fieldErrors(
    {
      errors: [
        { pointer: "/a~1b", code: "c", detail: "a slash" },
        { pointer: "/m~0n", code: "c", detail: "a tilde" },
        { pointer: "/~01", code: "c", detail: "a tilde, then 1" },
      ],
    },
    ["a/b", "m~n", "~1"],
  );
  expect(byField).toEqual({
    "a/b": "a slash",
    "m~n": "a tilde",
    "~1": "a tilde, then 1",
  });
});

test("no problem, no errors", () => {
  expect(fieldErrors(undefined, ["slug"])).toEqual({ byField: {}, rest: [] });
});
