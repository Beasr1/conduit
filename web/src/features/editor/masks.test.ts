import { describe, expect, it } from "vitest";

import {
  fieldsIn,
  type MaskKind,
  kindOf,
  maskOf,
} from "@/features/editor/masks";

describe("kindOf and maskOf", () => {
  it("name a mask by what it keeps, and back", () => {
    const cases: [MaskKind, ReturnType<typeof maskOf>][] = [
      ["none", undefined],
      ["all", {}],
      ["start", { start: 4 }],
      ["end", { end: 4 }],
      ["both", { start: 4, end: 4 }],
    ];
    for (const [kind, mask] of cases) {
      expect(maskOf(kind)).toEqual(mask);
      expect(kindOf(mask)).toBe(kind);
    }
  });

  it("keep the characters already chosen for an end that stays", () => {
    expect(maskOf("both", { end: 2 })).toEqual({ start: 4, end: 2 });
    expect(maskOf("start", { start: 6, end: 2 })).toEqual({ start: 6 });
    expect(maskOf("end", { start: 6 })).toEqual({ end: 4 });
  });
});

describe("fieldsIn", () => {
  it("offers each field that holds a value, as an expression reads it", () => {
    expect(
      fieldsIn({
        customer: {
          emirates_id: "784199012345671",
          "first-name": "Fatima",
          contacts: [{ phone: "+971501234567" }, { email: "a@b.example" }],
        },
        tags: ["vip"],
        verified: true,
        none: null,
      }),
    ).toEqual([
      "customer.emirates_id",
      "customer.`first-name`",
      "customer.contacts.phone",
      "customer.contacts.email",
      "tags",
      "verified",
      "none",
    ]);
  });

  it("offers nothing of what isn't an object, and each field once", () => {
    expect(fieldsIn("784199012345671")).toEqual([]);
    expect(fieldsIn(undefined)).toEqual([]);
    expect(fieldsIn([{ id: 1 }, { id: 2 }])).toEqual(["id"]);
  });
});
