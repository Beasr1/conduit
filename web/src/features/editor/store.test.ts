import { expect, test } from "vitest";

import { connect, removeNodes, removeOutput } from "@/features/editor/edits";
import { toFlow } from "@/features/editor/flow";
import { RESPONSE } from "@/features/editor/flow";
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

// Selecting a step and leaving its fields as they were mustn't count as an
// edit, or nothing could tell an untouched draft from a changed one.
test("an edit that changes nothing leaves the draft alone", () => {
  const store = createEditorStore(specExample);
  store.getState().edit((d) => d);
  expect(store.getState().draft).toBe(specExample);
});

test("a deleted node drops out of the selection", () => {
  const store = createEditorStore(specExample);
  store.getState().pick("nodes", [{ id: "crm", selected: true }]);
  store.getState().edit((d) => removeNodes(d, [3]));
  expect(store.getState().selected.nodes).toEqual([]);
});

test("a renamed node stays selected, under its new id", () => {
  const store = createEditorStore(specExample);
  store.getState().pick("nodes", [{ id: "user", selected: true }]);
  store.getState().rename(0, "person");
  expect(store.getState().selected.nodes).toEqual(["person"]);
  expect(store.getState().draft.edges?.[0]).toEqual({
    from: "person",
    to: "orders",
  });
});

test("opening the workflow's settings puts away what was picked, and a pick closes them", () => {
  const store = createEditorStore(specExample);
  store.getState().pick("nodes", [{ id: "crm", selected: true }]);
  store.getState().openPanel("settings");
  expect(store.getState().selected).toEqual({ nodes: [], edges: [] });
  expect(store.getState().panel).toBe("settings");
  store.getState().pick("edges", [{ id: "user->orders", selected: true }]);
  expect(store.getState().panel).toBeUndefined();
});

test("the response card stays picked through edits", () => {
  const store = createEditorStore(specExample);
  store.getState().pick("nodes", [{ id: RESPONSE, selected: true }]);
  store.getState().edit((d) => ({ ...d, output: "nodes.crm.body" }));
  expect(store.getState().selected.nodes).toEqual([RESPONSE]);
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

// user answers 2xx or 404.
const branched = {
  ...specExample,
  nodes: specExample.nodes.map((n) =>
    n.id === "user" ? { ...n, outputs: [{ status: 404 }] } : n,
  ),
};

test("picking a step opens its request, whatever part of another was open", () => {
  const store = createEditorStore(branched);
  store.getState().pick("nodes", [{ id: "user", selected: true }]);
  expect(store.getState().part).toBe("request");
  store.getState().setPart("404");
  store.getState().pick("nodes", [
    { id: "user", selected: false },
    { id: "crm", selected: true },
  ]);
  expect(store.getState().part).toBe("request");
});

test("removing the response open takes its step back to the request", () => {
  const store = createEditorStore(branched);
  store.getState().pick("nodes", [{ id: "user", selected: true }]);
  store.getState().setPart("404");
  store.getState().edit((d) => ({ ...d, output: "nodes.user.body" }));
  expect(store.getState().part).toBe("404");
  store.getState().edit((d) => removeOutput(d, 0, 404));
  expect(store.getState().part).toBe("request");
});

test("showing where a problem is opens the part it's in", () => {
  const store = createEditorStore(branched);
  store.getState().show("nodes", "user", "404");
  expect(store.getState().part).toBe("404");
  store.getState().show("nodes", "crm");
  expect(store.getState().part).toBe("request");
});

test("showing where a problem is picks only that, and puts the panel away", () => {
  const store = createEditorStore(specExample);
  store.getState().pick("nodes", [{ id: "user", selected: true }]);
  store.getState().openPanel("problems");
  store.getState().show("edges", "user->orders");
  expect(store.getState().selected).toEqual({
    nodes: [],
    edges: ["user->orders"],
  });
  expect(store.getState().panel).toBeUndefined();
});
