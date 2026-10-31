import type { XYPosition } from "@xyflow/react";

import {
  freeSpot,
  handlesOf,
  NODE_WIDTH,
  RANK_GAP,
  toFlow,
} from "@/features/editor/flow";
import type { components } from "@/gen/schema";

type Answer = components["schemas"]["Answer"];
type Case = components["schemas"]["Case"];
type Definition = components["schemas"]["Definition"];
type Edge = components["schemas"]["Edge"];
type Node = components["schemas"]["Node"];
type Otherwise = components["schemas"]["Otherwise"];
type Position = components["schemas"]["Position"];
type Response = components["schemas"]["Response"];
type Switch = components["schemas"]["Switch"];

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

// joinedTo is the places in the response's answers of those joined to
// output on of node from (2xx, or a transform's one, when there's none):
// the answers that output gives.
export function joinedTo(d: Definition, from: string, on?: number): number[] {
  return (d.response?.answers ?? []).flatMap((a, k) =>
    a.from === from && (a.on ?? 0) === (on ?? 0) ? [k] : [],
  );
}

// canJoin says whether a line may be drawn into answer k: each takes one. A
// line from a step that's gone can be drawn again.
export function canJoin(d: Definition, k: number): boolean {
  const a = d.response?.answers?.[k];
  return a !== undefined && (!a.from || !d.nodes.some((n) => n.id === a.from));
}

// refusal is why a line from step into answer k can't be drawn: the
// answer's status, and the other step its one line is from. Undefined when
// the line can be drawn, or already is.
export function refusal(
  d: Definition,
  step: string,
  k: number,
): { status: number; from: string } | undefined {
  const a = d.response?.answers?.[k];
  if (!a?.from || a.from === step || canJoin(d, k)) return undefined;
  return { status: a.status, from: a.from };
}

// joinAnswer joins node from, on its output on (2xx, or a transform's one,
// when there's none), to answer k, in place of any line it had. A
// transform joined to a second answer picks between them, so it becomes a
// switch: otherwise keeps its expression as the first answer's body, and a
// case for the new status waits to be filled. A switch gets a case for a
// status it doesn't give yet.
export function joinAnswer(
  d: Definition,
  k: number,
  from: string,
  on?: number,
): Definition {
  const answers = d.response?.answers;
  const answer = answers?.[k];
  if (!answers || !answer) return d;
  const before = joinedTo(d, from, on).filter((j) => j !== k);
  const line = {
    ...unjoined(answer),
    from,
    ...(on === undefined ? {} : { on }),
  };
  const joined = {
    ...d,
    response: { ...d.response, answers: answers.with(k, line) },
  };
  const index = d.nodes.findIndex((n) => n.id === from);
  const node = d.nodes[index];
  if (node?.kind !== "transform") return joined;
  if (node.switch)
    return updateNode(joined, index, (n) => withCase(n, answer.status));
  const first = answers[before[0] ?? -1]?.status;
  if (first === undefined) return joined;
  return updateNode(joined, index, (n) =>
    withCase(toSwitch(n, first), answer.status),
  );
}

// leaveAnswer takes away the line into answer k; the answer stays.
export function leaveAnswer(d: Definition, k: number): Definition {
  const answers = d.response?.answers;
  const a = answers?.[k];
  if (!answers || !a || (a.from === undefined && a.on === undefined)) return d;
  return {
    ...d,
    response: { ...d.response, answers: answers.with(k, unjoined(a)) },
  };
}

// unjoinWhere takes away the lines into the answers lost picks.
function unjoinWhere(d: Definition, lost: (a: Answer) => boolean): Definition {
  const answers = d.response?.answers;
  if (!answers?.some(lost)) return d;
  return {
    ...d,
    response: {
      ...d.response,
      answers: answers.map((a) => (lost(a) ? unjoined(a) : a)),
    },
  };
}

// unjoined is an answer without its line.
function unjoined(a: Answer): Answer {
  return a.schema
    ? { status: a.status, schema: a.schema }
    : { status: a.status };
}

// addAnswer gives the response an answer for status, after its others, with
// no line yet.
export function addAnswer(d: Definition, status: number): Definition {
  const r = d.response ?? {};
  return {
    ...d,
    response: { ...r, answers: [...(r.answers ?? []), { status }] },
  };
}

// removeAnswer takes away answer k. A response left with neither an answer
// nor unhandled goes.
export function removeAnswer(d: Definition, k: number): Definition {
  const r = d.response;
  if (!r?.answers?.[k]) return d;
  return withResponse(d, {
    ...r,
    answers: r.answers.filter((_, i) => i !== k),
  });
}

// setAnswerSchema gives answer k a schema; undefined removes it. A schema it
// already has gives back the draft itself.
export function setAnswerSchema(
  d: Definition,
  k: number,
  schema: Answer["schema"],
): Definition {
  const r = d.response;
  const before = r?.answers?.[k];
  if (!r?.answers || !before) return d;
  if (JSON.stringify(before.schema) === JSON.stringify(schema)) return d;
  const after: Answer = { ...before };
  if (schema === undefined) delete after.schema;
  else after.schema = schema;
  return { ...d, response: { ...r, answers: r.answers.with(k, after) } };
}

// setUnhandled gives the response an unhandled whose body is body;
// undefined removes it. A body it already has gives back the draft itself.
export function setUnhandled(
  d: Definition,
  body: string | undefined,
): Definition {
  const r = d.response ?? {};
  if (r.unhandled?.body === body) return d;
  const next = { ...r };
  if (body === undefined) delete next.unhandled;
  else next.unhandled = { body };
  return withResponse(d, next);
}

// withResponse puts r in place of the response. One with neither an answer
// nor unhandled goes.
function withResponse(d: Definition, r: Response): Definition {
  if ((r.answers ?? []).length > 0 || r.unhandled) return { ...d, response: r };
  const next = { ...d };
  delete next.response;
  return next;
}

// toSwitch turns transform node n's expression into the otherwise of a
// switch, with status, and no cases yet.
export function toSwitch(n: Node, status: number): Node {
  const next: Node = {
    ...n,
    switch: { otherwise: { status, ...(n.expr ? { body: n.expr } : {}) } },
  };
  delete next.expr;
  return next;
}

// withCase gives switch node n a case for status, its condition to fill,
// unless a case or its otherwise gives status already.
function withCase(n: Node, status: number): Node {
  const s = n.switch;
  if (!s) return n;
  const gives = [s.otherwise.status, ...(s.cases ?? []).map((c) => c.status)];
  if (gives.includes(status)) return n;
  return {
    ...n,
    switch: { ...s, cases: [...(s.cases ?? []), { when: "", status }] },
  };
}

// addCase gives switch node index a case for status, after its others.
export function addCase(
  d: Definition,
  index: number,
  status: number,
): Definition {
  return updateSwitch(d, index, (s) => ({
    ...s,
    cases: [...(s.cases ?? []), { when: "", status }],
  }));
}

// updateCase puts what change makes of case k in its place.
export function updateCase(
  d: Definition,
  index: number,
  k: number,
  change: (c: Case) => Case,
): Definition {
  return updateSwitch(d, index, (s) => {
    const c = s.cases?.[k];
    return c && s.cases ? { ...s, cases: s.cases.with(k, change(c)) } : s;
  });
}

// removeCase takes case k away.
export function removeCase(
  d: Definition,
  index: number,
  k: number,
): Definition {
  return updateSwitch(d, index, (s) => ({
    ...s,
    cases: (s.cases ?? []).filter((_, i) => i !== k),
  }));
}

// moveCase moves case k to place to, as the first that holds answers.
export function moveCase(
  d: Definition,
  index: number,
  k: number,
  to: number,
): Definition {
  return updateSwitch(d, index, (s) => {
    const cases = [...(s.cases ?? [])];
    const [c] = cases.splice(k, 1);
    if (!c || to < 0 || to > cases.length) return s;
    cases.splice(to, 0, c);
    return { ...s, cases };
  });
}

// updateOtherwise puts what change makes of a switch's otherwise in its
// place.
export function updateOtherwise(
  d: Definition,
  index: number,
  change: (o: Otherwise) => Otherwise,
): Definition {
  return updateSwitch(d, index, (s) => ({
    ...s,
    otherwise: change(s.otherwise),
  }));
}

function updateSwitch(
  d: Definition,
  index: number,
  change: (s: Switch) => Switch,
): Definition {
  return updateNode(d, index, (n) =>
    n.switch ? { ...n, switch: change(n.switch) } : n,
  );
}

// outputToStep moves a definition's output, kept from the revisions saved
// with one, into a transform step, respond, joined to the response's one
// answer, 200, the output schema that answer's. The step runs after the
// steps the output reads, whichever way each answers, and goes after the
// rightmost of them that's placed. Without an output, or beside a response,
// it gives back the draft itself; else the step's id too.
export function outputToStep(d: Definition): {
  draft: Definition;
  step?: string;
} {
  if (!d.output || d.response) return { draft: d };
  const ids = new Set(d.nodes.map((n) => n.id));
  let step = "respond";
  for (let k = 2; ids.has(step); k++) step = `respond_${k}`;

  const read = reads(d, d.output);
  const edges = read.flatMap((from) => {
    const node = d.nodes.find((n) => n.id === from);
    return (node ? handlesOf(node) : []).map((h) => {
      const on = Number(h);
      return Number.isInteger(on) ? { from, to: step, on } : { from, to: step };
    });
  });
  const { output, output_schema: schema, ...rest } = d;
  const moved: Definition = {
    ...rest,
    nodes: [...d.nodes, { id: step, kind: "transform", expr: output }],
    edges: [...(d.edges ?? []), ...edges],
    response: {
      answers: [{ status: 200, from: step, ...(schema ? { schema } : {}) }],
    },
  };

  const stored = d.ui?.positions ?? {};
  const placed = read.flatMap((id) => (stored[id] ? [stored[id]] : []));
  if (placed.length === 0) return { draft: moved, step };
  const at = freeSpot(
    {
      x: Math.max(...placed.map((p) => p.x)) + NODE_WIDTH + RANK_GAP,
      y: placed.reduce((sum, p) => sum + p.y, 0) / placed.length,
    },
    Object.values(stored),
  );
  return { draft: move(moved, { [step]: at }), step };
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
// edges that leave from it, as removing a node takes its edges, and the line
// into the response if it leaves from it.
export function removeOutput(
  d: Definition,
  index: number,
  status: number,
): Definition {
  const id = d.nodes[index]?.id;
  let removed = updateNode(d, index, (n) => {
    const next = { ...n };
    const outputs = (n.outputs ?? []).filter((o) => o.status !== status);
    if (outputs.length > 0) next.outputs = outputs;
    else delete next.outputs;
    return next;
  });
  removed = unjoinWhere(removed, (a) => a.from === id && a.on === status);
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

// renameNode gives a node a new id. Its edges, the line into the response
// and its position go with it, unless another node still has the old id:
// they stay with that node, which the canvas already draws them on.
// Expressions are text and keep the old id; mentions finds them.
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
  if (d.response?.answers)
    renamed.response = {
      ...d.response,
      answers: d.response.answers.map((a) =>
        a.from === from ? { ...a, from: to } : a,
      ),
    };
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

// removeNodes removes nodes by their places in definition.nodes. The edges,
// line into the response and positions of an id that no node has any more go
// with them; those of a node that shared its id with one that stays don't.
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
  const kept = unjoinWhere(d, (a) => a.from !== undefined && lost.has(a.from));
  if (!d.ui) return { ...kept, nodes, edges };
  const positions = Object.fromEntries(
    Object.entries(d.ui.positions ?? {}).filter(([id]) => !lost.has(id)),
  );
  return { ...kept, nodes, edges, ui: { ...d.ui, positions } };
}
