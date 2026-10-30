import type { XYPosition } from "@xyflow/react";

import { toFlow } from "@/features/editor/flow";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type Edge = components["schemas"]["Edge"];
type Node = components["schemas"]["Node"];
type Position = components["schemas"]["Position"];

// The definition's rule for a node id, from schema/workflow.yaml. The editor
// checks an id against it as it's typed; the server checks it again and
// decides.
export const NODE_ID = /^[a-z][a-z0-9_]{0,63}$/;

// What an id must be, and why one is refused, as the forms and the server's
// problems say it.
export const ID_RULE =
  "A lowercase letter, then up to 63 lowercase letters, digits and underscores.";
export const ID_TAKEN = "Another step already has this id.";

// Each edit takes the draft and returns a new one, leaving its input as it
// was, so the store can tell a change by identity.

// Stored positions are whole numbers: a fraction of a pixel means nothing on
// the canvas.
function round(p: XYPosition): Position {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

export function addNode(d: Definition, node: Node, at: XYPosition): Definition {
  return {
    ...d,
    nodes: [...d.nodes, node],
    ui: { ...d.ui, positions: { ...d.ui?.positions, [node.id]: round(at) } },
  };
}

// move stores where nodes were dragged to, by node id.
export function move(
  d: Definition,
  to: Record<string, XYPosition>,
): Definition {
  const positions = { ...d.ui?.positions };
  for (const [id, p] of Object.entries(to)) positions[id] = round(p);
  return { ...d, ui: { ...d.ui, positions } };
}

// settle writes down where every node is drawn. The store applies it before
// each edit, so the first edit keeps the layout as the user sees it: a node
// placed automatically doesn't move because another was dragged, or because
// a new edge changed the automatic layout. A node keyed with "#" (a missing
// or shared id) can't be stored by id, so the layout goes on placing it.
export function settle(d: Definition): Definition {
  const stored = d.ui?.positions ?? {};
  const unplaced = toFlow(d).nodes.filter(
    (n) => !n.id.includes("#") && !stored[n.id],
  );
  if (unplaced.length === 0) return d;
  return move(d, Object.fromEntries(unplaced.map((n) => [n.id, n.position])));
}

// canConnect says whether an edge may be drawn from one node, leaving from
// its output on (2xx when there's none), to another: not to itself, not
// twice from the same output, and not closing a cycle. It's only for feel;
// the server's validation still decides.
export function canConnect(
  d: Definition,
  from: string,
  to: string,
  on?: number,
): boolean {
  if (from === to) return false;
  const twice = (d.edges ?? []).some(
    (e) => e.from === from && e.to === to && e.on === on,
  );
  return !twice && !reaches(d, to, from);
}

// reaches reports whether edges lead from one node to another.
function reaches(d: Definition, from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const e of d.edges ?? [])
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const stack = [from];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

export function connect(
  d: Definition,
  from: string,
  to: string,
  on?: number,
): Definition {
  const edge = on === undefined ? { from, to } : { from, to, on };
  return { ...d, edges: [...(d.edges ?? []), edge] };
}

// addOutput gives node index an output for status, after its others.
export function addOutput(
  d: Definition,
  index: number,
  status: number,
): Definition {
  return updateNode(d, index, (n) => ({
    ...n,
    outputs: [...(n.outputs ?? []), { status }],
  }));
}

// removeOutput takes node index's output for status away, and with it the
// edges that leave from it, as removing a node takes its edges.
export function removeOutput(
  d: Definition,
  index: number,
  status: number,
): Definition {
  const id = d.nodes[index]?.id;
  const removed = updateNode(d, index, (n) => {
    const next = { ...n };
    const outputs = (n.outputs ?? []).filter((o) => o.status !== status);
    if (outputs.length > 0) next.outputs = outputs;
    else delete next.outputs;
    return next;
  });
  if (!removed.edges) return removed;
  return {
    ...removed,
    edges: removed.edges.filter((e) => e.from !== id || e.on !== status),
  };
}

// updateNode puts what change makes of a node in its place. A change that
// alters nothing gives back the draft itself, so the store can skip it.
export function updateNode(
  d: Definition,
  index: number,
  change: (n: Node) => Node,
): Definition {
  const before = d.nodes[index];
  if (!before) return d;
  const after = change(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return d;
  return { ...d, nodes: d.nodes.with(index, after) };
}

// updateEdge puts what change makes of an edge in its place, as updateNode
// does for a node.
export function updateEdge(
  d: Definition,
  index: number,
  change: (e: Edge) => Edge,
): Definition {
  const before = d.edges?.[index];
  if (!before) return d;
  const after = change(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return d;
  return { ...d, edges: (d.edges ?? []).with(index, after) };
}

// setField gives one of the workflow's own fields a value; undefined removes
// it. A value it already has gives back the draft itself.
export function setField<
  K extends "output" | "input_schema" | "output_schema" | "sample_input",
>(d: Definition, key: K, value: Definition[K]): Definition {
  if (JSON.stringify(d[key]) === JSON.stringify(value)) return d;
  const next = { ...d };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

// renameNode gives a node a new id. Its edges and position go with it,
// unless another node still has the old id: they stay with that node, which
// the canvas already draws them on. Expressions are text and keep the old
// id; mentions finds them.
export function renameNode(
  d: Definition,
  index: number,
  to: string,
): Definition {
  const from = d.nodes[index]?.id;
  if (from === undefined || from === to) return d;
  const nodes = d.nodes.map((n, i) => (i === index ? { ...n, id: to } : n));
  const renamed: Definition = { ...d, nodes };
  if (nodes.some((n) => n.id === from)) return renamed;
  if (d.edges)
    renamed.edges = d.edges.map((e) => ({
      ...e,
      from: e.from === from ? to : e.from,
      to: e.to === from ? to : e.to,
    }));
  if (d.ui?.positions?.[from]) {
    const positions = Object.fromEntries(
      Object.entries(d.ui.positions)
        .filter(([id]) => id !== to)
        .map(([id, p]) => [id === from ? to : id, p]),
    );
    renamed.ui = { ...d.ui, positions };
  }
  return renamed;
}

// mentions lists the places whose text reads a node's result as
// nodes.<id>. It's a plain text match, since the browser doesn't parse
// JSONata, so a mention inside a string literal counts too.
export function mentions(d: Definition, id: string): string[] {
  if (id === "") return [];
  const pattern = reading(id);
  const found: string[] = [];
  const check = (place: string, ...texts: (string | undefined)[]) => {
    if (texts.some((t) => t !== undefined && pattern.test(t)))
      found.push(place);
  };
  for (const n of d.nodes) {
    const r = n.request;
    check(`${n.id}'s URL`, r?.url);
    check(`${n.id}'s headers`, ...Object.values(r?.headers ?? {}));
    check(`${n.id}'s query`, ...Object.values(r?.query ?? {}));
    check(`${n.id}'s body`, r?.body);
    check(`${n.id}'s expression`, n.expr);
  }
  for (const e of d.edges ?? [])
    check(`the condition on the edge from ${e.from} to ${e.to}`, e.when);
  check("the workflow's output", d.output);
  return found;
}

// reads lists the nodes an expression reads as nodes.<id>, in the
// definition's order, by the same plain text match.
export function reads(d: Definition, text: string | undefined): string[] {
  if (!text) return [];
  const ids = [...new Set(d.nodes.map((n) => n.id))];
  return ids.filter((id) => id !== "" && reading(id).test(text));
}

// parents lists the nodes with an edge into the node with id.
export function parents(d: Definition, id: string | undefined): string[] {
  return (d.edges ?? []).filter((e) => e.to === id).map((e) => e.from);
}

// reading matches text that reads a node's result as nodes.<id>. A draft
// saved with problems can hold any id, so it's escaped.
function reading(id: string): RegExp {
  return new RegExp(
    `\\bnodes\\.${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  );
}

// removeEdges removes edges by their places in definition.edges.
export function removeEdges(d: Definition, indexes: number[]): Definition {
  const gone = new Set(indexes);
  return { ...d, edges: (d.edges ?? []).filter((_, i) => !gone.has(i)) };
}

// removeNodes removes nodes by their places in definition.nodes. The edges
// and positions of an id that no node has any more go with them; those of a
// node that shared its id with one that stays don't.
export function removeNodes(d: Definition, indexes: number[]): Definition {
  const gone = new Set(indexes);
  const nodes = d.nodes.filter((_, i) => !gone.has(i));
  const left = new Set(nodes.map((n) => n.id));
  const lost = new Set(
    d.nodes.filter((n, i) => gone.has(i) && !left.has(n.id)).map((n) => n.id),
  );
  const edges = (d.edges ?? []).filter(
    (e) => !lost.has(e.from) && !lost.has(e.to),
  );
  if (!d.ui) return { ...d, nodes, edges };
  const positions = Object.fromEntries(
    Object.entries(d.ui.positions ?? {}).filter(([id]) => !lost.has(id)),
  );
  return { ...d, nodes, edges, ui: { ...d.ui, positions } };
}
