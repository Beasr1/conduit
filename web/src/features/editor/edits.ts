import type { XYPosition } from "@xyflow/react";

import {
  freeSpot,
  lineFrom,
  NODE_WIDTH,
  outputOf,
  RANK_GAP,
  toFlow,
  UNHANDLED,
} from "@/features/editor/flow";
import type { components } from "@/gen/schema";

type Answer = components["schemas"]["Answer"];
type AnswerLine = components["schemas"]["AnswerLine"];
type Case = components["schemas"]["Case"];
type Definition = components["schemas"]["Definition"];
type Edge = components["schemas"]["Edge"];
type Node = components["schemas"]["Node"];
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
// its output on (2xx when there's none, or its Unhandled block), to another: not to itself, not
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
    (e) => e.from === from && e.to === to && outputOf(e) === on,
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

// connect draws an edge from one node, leaving from its output on, to
// another. A line from its Unhandled block takes its failures, so the node
// no longer fails the run with them.
export function connect(
  d: Definition,
  from: string,
  to: string,
  on?: number,
): Definition {
  const edge = { from, to, ...lineFrom(on) };
  const drawn = { ...d, edges: [...(d.edges ?? []), edge] };
  return on === UNHANDLED ? goesOn(drawn, from) : drawn;
}

// goesOn takes away node id's choice to fail the run, as a line or an
// answer now leaves its Unhandled block: it can do only one (plan 12).
function goesOn(d: Definition, id: string): Definition {
  const index = d.nodes.findIndex((n) => n.id === id);
  return index < 0 ? d : setStepFails(d, index, false);
}

// leaves says whether a line into an answer leaves output on of node from:
// 2xx, or a transform's one, when there's none; a case's exit; or its
// Unhandled block.
function leaves(l: AnswerLine, from: string, on?: number): boolean {
  return l.from === from && (outputOf(l) ?? 0) === (on ?? 0);
}

// joinedTo is the places in the response's answers of those joined to
// output on of node from: the answers that output gives.
export function joinedTo(d: Definition, from: string, on?: number): number[] {
  return (d.response?.answers ?? []).flatMap((a, k) =>
    (a.lines ?? []).some((l) => leaves(l, from, on)) ? [k] : [],
  );
}

// canJoin says whether a line from node from's output on may be drawn into
// answer k: an answer takes lines from any number of steps (plan 14), but
// each once.
export function canJoin(
  d: Definition,
  k: number,
  from: string,
  on?: number,
): boolean {
  const a = d.response?.answers?.[k];
  return a !== undefined && !(a.lines ?? []).some((l) => leaves(l, from, on));
}

// joinAnswer joins node from, on its output on (2xx, or a transform's one,
// when there's none; a case's exit; or its Unhandled block), to answer k,
// after the lines it has. A run gives the first answer, top to bottom, that
// one of its lines reached (plan 14), so an output gives one answer, and its
// line into another goes. But a transform with an expression joined to a
// second answer picks between them, so it gets cases: the first keeps its
// expression as the first answer's body, and one for the new status follows
// it, each waiting for its condition, and each answer's line on the exit of
// its status. A line from Unhandled, or from a case, picks nothing.
export function joinAnswer(
  d: Definition,
  k: number,
  from: string,
  on?: number,
): Definition {
  const answers = d.response?.answers;
  const answer = answers?.[k];
  if (!answers || !answer || !canJoin(d, k, from, on)) return d;
  const index = d.nodes.findIndex((n) => n.id === from);
  const node = d.nodes[index];
  const picks = on !== UNHANDLED && node?.kind === "transform" && !node.switch;
  const before = joinedTo(d, from, on);
  const moved = picks ? d : unjoinWhere(d, (l) => leaves(l, from, on));
  const after = moved.response?.answers ?? answers;
  const target = after[k] ?? answer;
  const joined = {
    ...moved,
    response: {
      ...moved.response,
      answers: after.with(
        k,
        withLines(target, [...(target.lines ?? []), { from, ...lineFrom(on) }]),
      ),
    },
  };
  if (on === UNHANDLED) return goesOn(joined, from);
  const first = answers[before[0] ?? -1]?.status;
  if (!picks || first === undefined) return joined;
  return toCases(joined, index, first);
}

// leaveLines takes away lines into answers, by identity, so several go at
// once whatever their places; the answers stay.
export function leaveLines(d: Definition, gone: AnswerLine[]): Definition {
  const lines = new Set(gone);
  return unjoinWhere(d, (l) => lines.has(l));
}

// unjoinWhere takes away the lines into answers that lost picks.
function unjoinWhere(
  d: Definition,
  lost: (l: AnswerLine) => boolean,
): Definition {
  return mapLines(d, (l) => (lost(l) ? undefined : l));
}

// mapLines puts what change makes of each line into an answer in its place,
// dropping those it makes nothing of; the answers stay. A change that alters
// nothing gives back the draft itself.
function mapLines(
  d: Definition,
  change: (l: AnswerLine, a: Answer) => AnswerLine | undefined,
): Definition {
  const answers = d.response?.answers;
  if (!answers) return d;
  let changed = false;
  const next = answers.map((a) => {
    const lines = a.lines ?? [];
    const kept = lines.flatMap((l) => {
      const after = change(l, a);
      if (after !== l) changed = true;
      return after ? [after] : [];
    });
    return kept.length === lines.length && kept.every((l, i) => l === lines[i])
      ? a
      : withLines(a, kept);
  });
  return changed ? { ...d, response: { ...d.response, answers: next } } : d;
}

// withLines is answer a with lines; with none, it has no lines at all.
function withLines(a: Answer, lines: AnswerLine[]): Answer {
  const next = { ...a };
  if (lines.length === 0) delete next.lines;
  else next.lines = lines;
  return next;
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

// moveAnswer moves answer k to place to: a run gives the first answer, top
// to bottom, that one of its lines reached (plan 14).
export function moveAnswer(d: Definition, k: number, to: number): Definition {
  const answers = d.response?.answers;
  const a = answers?.[k];
  if (!answers || !a || k === to || to < 0 || to >= answers.length) return d;
  const next = answers.filter((_, i) => i !== k);
  next.splice(to, 0, a);
  return { ...d, response: { ...d.response, answers: next } };
}

// removeAnswer takes away answer k. A response left with neither an answer
// nor an error body goes.
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

// setStepUnhandled gives step index's Unhandled block body, what it gives
// once it takes the step's failure; undefined removes it, so the block gives
// what the step got. A body it already has gives back the draft itself.
export function setStepUnhandled(
  d: Definition,
  index: number,
  body: string | undefined,
): Definition {
  const n = d.nodes[index];
  if (!n || n.unhandled?.body === body) return d;
  return updateNode(d, index, (node) =>
    withUnhandled(node, { ...node.unhandled, body }),
  );
}

// setStepFails says whether step index fails the run with its failures, on
// purpose, rather than leaving them to a line from its Unhandled block
// (plan 12). Its Unhandled body stays, for when it doesn't.
export function setStepFails(
  d: Definition,
  index: number,
  fail: boolean,
): Definition {
  const n = d.nodes[index];
  if (!n || (n.unhandled?.fail ?? false) === fail) return d;
  return updateNode(d, index, (node) =>
    withUnhandled(node, { ...node.unhandled, fail: fail || undefined }),
  );
}

// withUnhandled gives a node u as its Unhandled, leaving out the parts it
// doesn't set, and the whole when it sets none.
function withUnhandled(
  node: Definition["nodes"][number],
  u: { body?: string; fail?: boolean },
): Definition["nodes"][number] {
  const next = { ...node };
  const kept = {
    ...(u.fail ? { fail: true } : {}),
    ...(u.body === undefined ? {} : { body: u.body }),
  };
  if (Object.keys(kept).length === 0) delete next.unhandled;
  else next.unhandled = kept;
  return next;
}

// setErrorBody gives the response the error body, what answers each error
// the workflow passes on without a body of its own (plan 12); undefined
// removes it, so Conduit's problem details answer them. A body it already
// has gives back the draft itself.
export function setErrorBody(
  d: Definition,
  body: string | undefined,
): Definition {
  const r = d.response ?? {};
  if (r.errors?.body === body) return d;
  const next = { ...r };
  if (body === undefined) delete next.errors;
  else next.errors = { body };
  return withResponse(d, next);
}

// withResponse puts r in place of the response. One with neither an answer
// nor an error body goes.
function withResponse(d: Definition, r: Response): Definition {
  if ((r.answers ?? []).length > 0 || r.errors) return { ...d, response: r };
  const next = { ...d };
  delete next.response;
  return next;
}

// toCases turns transform node index's expression into cases: it becomes
// the body of the first, which exits with status, and each other answer the
// step is joined to gets a case of its own; each case's condition waits to
// be filled. Each line goes along: one into an answer leaves the exit of the
// answer's status, and one to a step the first case's.
export function toCases(
  d: Definition,
  index: number,
  status: number,
): Definition {
  const n = d.nodes[index];
  if (n?.kind !== "transform" || n.switch) return d;
  const id = n.id;
  const one = (line: { from?: string; on?: number; unhandled?: boolean }) =>
    line.from === id && outputOf(line) === undefined;
  const answers = d.response?.answers ?? [];
  const others = answers
    .filter((a) => (a.lines ?? []).some(one) && a.status !== status)
    .map((a) => ({ when: "", status: a.status }));
  const cased = updateNode(d, index, (node) => {
    const first = {
      when: "",
      status,
      ...(node.expr ? { body: node.expr } : {}),
    };
    const next: Node = { ...node, switch: { cases: [first, ...others] } };
    delete next.expr;
    return next;
  });
  return mapLines(
    {
      ...cased,
      ...(cased.edges && {
        edges: cased.edges.map((e) => (one(e) ? { ...e, on: status } : e)),
      }),
    },
    (l, a) => (one(l) ? { ...l, on: a.status } : l),
  );
}

// addCase gives switch node index a case for status, after its others, and
// its name, if it's given one.
export function addCase(
  d: Definition,
  index: number,
  status: number,
  name?: string,
): Definition {
  return updateSwitch(d, index, (s) => ({
    ...s,
    cases: [
      ...(s.cases ?? []),
      { ...(name ? { name } : {}), when: "", status },
    ],
  }));
}

// setCaseStatus gives case k of switch node index status, and the lines
// leaving its exit go along.
export function setCaseStatus(
  d: Definition,
  index: number,
  k: number,
  status: number,
): Definition {
  const n = d.nodes[index];
  const was = n?.switch?.cases?.[k]?.status;
  if (!n || was === undefined || was === status) return d;
  return moveExit(
    updateCase(d, index, k, (c) => ({ ...c, status })),
    n.id,
    was,
    status,
  );
}

// moveExit has the lines leaving node id's exit was leave its exit now
// instead.
function moveExit(
  d: Definition,
  id: string,
  was: number,
  now: number,
): Definition {
  const moving = (line: { from?: string; on?: number }) =>
    line.from === id && line.on === was;
  return mapLines(
    {
      ...d,
      ...(d.edges && {
        edges: d.edges.map((e) => (moving(e) ? { ...e, on: now } : e)),
      }),
    },
    (l) => (moving(l) ? { ...l, on: now } : l),
  );
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

// removeCase takes case k away, and with it the lines leaving its exit, as
// removing an output takes its.
export function removeCase(
  d: Definition,
  index: number,
  k: number,
): Definition {
  const n = d.nodes[index];
  const status = n?.switch?.cases?.[k]?.status;
  const removed = updateSwitch(d, index, (s) => ({
    ...s,
    cases: (s.cases ?? []).filter((_, i) => i !== k),
  }));
  return status === undefined ? removed : leaveExit(removed, n?.id, status);
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
// 2xx of each step the output reads, as a step needs every line into it,
// and goes after the rightmost of them that's placed. Without an output,
// or beside a response, it gives back the draft itself; else the step's id
// too.
export function outputToStep(d: Definition): {
  draft: Definition;
  step?: string;
} {
  if (!d.output || d.response) return { draft: d };
  const ids = new Set(d.nodes.map((n) => n.id));
  let step = "respond";
  for (let k = 2; ids.has(step); k++) step = `respond_${k}`;

  const read = reads(d, d.output);
  const edges = read.map((from) => ({ from, to: step }));
  const { output, output_schema: schema, ...rest } = d;
  const moved: Definition = {
    ...rest,
    nodes: [...d.nodes, { id: step, kind: "transform", expr: output }],
    edges: [...(d.edges ?? []), ...edges],
    response: {
      answers: [
        { status: 200, lines: [{ from: step }], ...(schema ? { schema } : {}) },
      ],
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
  const removed = updateNode(d, index, (n) => {
    const next = { ...n };
    const outputs = (n.outputs ?? []).filter((o) => o.status !== status);
    if (outputs.length > 0) next.outputs = outputs;
    else delete next.outputs;
    return next;
  });
  return leaveExit(removed, d.nodes[index]?.id, status);
}

// leaveExit takes away the lines leaving node id's output status: its edges,
// and its lines into answers.
function leaveExit(
  d: Definition,
  id: string | undefined,
  status: number,
): Definition {
  const left = unjoinWhere(d, (l) => l.from === id && l.on === status);
  if (!left.edges) return left;
  return {
    ...left,
    edges: left.edges.filter((e) => e.from !== id || e.on !== status),
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
  const lines = mapLines(renamed, (l) =>
    l.from === from ? { ...l, from: to } : l,
  );
  if (lines !== renamed) renamed.response = lines.response;
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
    for (const [k, c] of (n.switch?.cases ?? []).entries())
      check(
        c.name ? `${n.id}'s case ${c.name}` : `${n.id}'s Case ${k + 1}`,
        c.when,
        c.body,
      );
    check(`${n.id}'s Unhandled body`, n.unhandled?.body);
  }
  for (const e of d.edges ?? []) {
    check(`the condition on the connection from ${e.from} to ${e.to}`, e.when);
  }
  check("the error body", d.response?.errors?.body);
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
  const kept = unjoinWhere(d, (l) => lost.has(l.from));
  if (!d.ui) return { ...kept, nodes, edges };
  const positions = Object.fromEntries(
    Object.entries(d.ui.positions ?? {}).filter(([id]) => !lost.has(id)),
  );
  return { ...kept, nodes, edges, ui: { ...d.ui, positions } };
}
