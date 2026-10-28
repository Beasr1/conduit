import { expect, test } from "vitest";

import { connect } from "@/features/editor/edits";
import { toFlow } from "@/features/editor/flow";
import { createEditorStore } from "@/features/editor/store";
import { specExample } from "@/test/fixtures";

const placed = (draft: Parameters<typeof toFlow>[0]) =>
  Object.fromEntries(toFlow(draft).nodes.map((n) => [n.id, n.position]));

// A workflow made through the API has no positions. The first drag must move
// only the node dragged, not send the rest elsewhere.
test("dragging one node leaves the others where they were drawn", () => {
  const store = createEditorStore(specExample);
  const before = placed(store.getState().draft);
  store.getState().drop({ crm: { x: 900, y: 400 } });
  const after = placed(store.getState().draft);
  expect(after.crm).toEqual({ x: 900, y: 400 });
  for (const id of ["user", "orders", "prefs"])
    expect(after[id]).toEqual(before[id]);
});

test("a new edge doesn't move a node that was placed automatically", () => {
  const store = createEditorStore(specExample);
  const before = placed(store.getState().draft);
  store.getState().edit((d) => connect(d, "user", "crm"));
  expect(placed(store.getState().draft)).toEqual(before);
});

test("selection follows what the canvas picks and unpicks", () => {
  const store = createEditorStore(specExample);
  store.getState().pick("nodes", [
    { id: "user", selected: true },
    { id: "crm", selected: true },
  ]);
  store.getState().pick("nodes", [{ id: "user", selected: false }]);
  expect(store.getState().selected).toEqual({ nodes: ["crm"], edges: [] });
});
