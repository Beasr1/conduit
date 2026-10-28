import { expect, test } from "vitest";

import {
  addNode,
  canConnect,
  connect,
  move,
  NODE_ID,
  removeEdges,
  removeNodes,
} from "@/features/editor/edits";
import type { components } from "@/gen/schema";
import { specExample as spec } from "@/test/fixtures";

type Definition = components["schemas"]["Definition"];

test.each([
  ["user", "crm", true],
  ["orders", "prefs", true],
  ["crm", "user", false], // would close a cycle through orders
  ["prefs", "user", false],
  ["user", "user", false], // a node can't be its own parent
  ["user", "orders", false], // already joined
])("connecting %s to %s allowed: %s", (from, to, allowed) => {
  expect(canConnect(spec, from, to)).toBe(allowed);
});

test("connect adds the edge and leaves the draft it was given alone", () => {
  const before = structuredClone(spec);
  const after = connect(spec, "user", "crm");
  expect(after.edges).toContainEqual({ from: "user", to: "crm" });
  expect(spec).toEqual(before);
});

test("a node is added where it was put, at a whole position", () => {
  const after = addNode(
    spec,
    { id: "notify", kind: "transform", expr: "1" },
    { x: 10.4, y: 20.6 },
  );
  expect(after.nodes.at(-1)?.id).toBe("notify");
  expect(after.ui?.positions?.notify).toEqual({ x: 10, y: 21 });
});

test("a drag stores where each node ended up", () => {
  const after = move(spec, {
    user: { x: 5.5, y: -3.2 },
    crm: { x: 900, y: 0 },
  });
  expect(after.ui?.positions).toEqual({
    user: { x: 6, y: -3 },
    crm: { x: 900, y: 0 },
  });
});

test("removing edges goes by their places in the list", () => {
  const after = removeEdges(spec, [0, 3]);
  expect(after.edges).toEqual([
    { from: "user", to: "prefs" },
    { from: "orders", to: "crm" },
  ]);
});

test("removing a node takes its edges and position with it", () => {
  const placed = move(spec, { orders: { x: 1, y: 2 }, crm: { x: 3, y: 4 } });
  const after = removeNodes(placed, [1]); // orders
  expect(after.nodes.map((n) => n.id)).toEqual(["user", "prefs", "crm"]);
  expect(after.edges).toEqual([
    { from: "user", to: "prefs" },
    { from: "prefs", to: "crm" },
  ]);
  expect(after.ui?.positions).toEqual({ crm: { x: 3, y: 4 } });
});

test("removing one of two nodes that share an id keeps the id's edges", () => {
  const draft: Definition = {
    nodes: [
      { id: "a", kind: "transform", expr: "1" },
      { id: "a", kind: "transform", expr: "2" },
      { id: "b", kind: "transform", expr: "3" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "ghost" },
    ],
  };
  const after = removeNodes(draft, [1]);
  expect(after.nodes).toHaveLength(2);
  expect(after.edges).toEqual(draft.edges);
});

test.each([
  ["fetch_user", true],
  ["a", true],
  ["Fetch", false],
  ["1st", false],
  ["has-dash", false],
  ["", false],
])("%j is a node id: %s", (id, ok) => {
  expect(NODE_ID.test(id)).toBe(ok);
});
