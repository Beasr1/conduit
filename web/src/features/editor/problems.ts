import { ID_RULE, ID_TAKEN } from "@/features/editor/edits";
import { ATTEMPTS_RULE, TIMEOUT_RULE } from "@/features/editor/fields";
import type { components } from "@/gen/schema";
import { tokens } from "@/lib/problems";

type Definition = components["schemas"]["Definition"];
type Edge = components["schemas"]["Edge"];
type ProblemError = components["schemas"]["ProblemError"];

// What the server found wrong with a draft, and the draft it looked at.
export interface Check {
  of: Definition;
  problems: ProblemError[];
}

// The parts of a step a problem can be about. The editor has no field for a
// step's kind, or for its request as a whole.
export type StepField =
  | "id"
  | "kind"
  | "request"
  | "expr"
  | "method"
  | "url"
  | "headers"
  | "query"
  | "body"
  | "timeout"
  | "attempts"
  | "idempotent"
  | "sample"
  | "outputs"
  | "switch"
  | "case_when"
  | "case_status"
  | "case_body"
  | "otherwise_status"
  | "otherwise_body"
  | "unhandled_body";

// The fields an HTTP step's Request tab holds: the call and its body.
export const REQUEST_FIELDS: ReadonlySet<StepField | undefined> = new Set([
  "method",
  "url",
  "headers",
  "query",
  "body",
  "timeout",
  "attempts",
  "idempotent",
]);

// The parts of the response a problem can be about: its line (from, and on
// for the block it leaves from, Unhandled's among them),
// its answers as a whole, one answer's status or schema, and the output and
// output schema of a revision saved with them.
export type ResponseField =
  | "from"
  | "on"
  | "answers"
  | "status"
  | "schema"
  | "unhandled"
  | "output"
  | "output_schema";

// Place is where a problem is: in a step or a connection, by its place in
// the definition; in the response card or the workflow's settings; or in the
// workflow as a whole. A header's or query parameter's problem names it, and
// one in a response besides 2xx, or its sample, has the response's place in
// the step's outputs, and one in a case its place in the switch's. One in an
// answer has the answer's place in the response's.
export type Place =
  | {
      on: "step";
      index: number;
      field?: StepField;
      name?: string;
      output?: number;
      case?: number;
    }
  | { on: "connection"; index: number; field?: "when" | "on" }
  | { on: "response"; field: ResponseField; answer?: number }
  | { on: "settings"; field: "input_schema" | "sample_input" }
  | { on: "workflow" };

// A problem as the editor shows it: where it is in the draft as it is now,
// the server's code for it, and what's wrong, in the screen's words.
export interface Found {
  place: Place;
  code: string;
  message: string;
}

// placeOf is the place a problem's JSON Pointer names.
export function placeOf(pointer: string): Place {
  const [top, i, ...rest] = tokens(pointer);
  if (top === "nodes" && isIndex(i)) return stepPlace(Number(i), rest);
  // The block a line leaves from is its on, or its Unhandled.
  if (top === "edges" && isIndex(i))
    return rest[0] === "when" || rest[0] === "on" || rest[0] === "unhandled"
      ? {
          on: "connection",
          index: Number(i),
          field: rest[0] === "when" ? "when" : "on",
        }
      : { on: "connection", index: Number(i) };
  if (top === "output" || top === "output_schema")
    return { on: "response", field: top };
  if (top === "response" && i === "unhandled")
    return { on: "response", field: "unhandled" };
  if (top === "response" && i === "answers") {
    const [k, part] = rest;
    if (!isIndex(k)) return { on: "response", field: "answers" };
    const field =
      part === "unhandled"
        ? "on"
        : part === "from" || part === "on" || part === "schema"
          ? part
          : "status";
    return { on: "response", field, answer: Number(k) };
  }
  if (top === "input_schema" || top === "sample_input")
    return { on: "settings", field: top };
  return { on: "workflow" };
}

// An array index as RFC 6901 writes one: digits, with no leading zero.
function isIndex(token: string | undefined): token is string {
  return token !== undefined && /^(0|[1-9][0-9]*)$/.test(token);
}

const requestParts = new Map<string, StepField>([
  ["method", "method"],
  ["url", "url"],
  ["body", "body"],
  ["timeout_ms", "timeout"],
]);

// switchPlace is the place a pointer below a step's switch names: a case's
// condition, status or body, otherwise's status or body, or the switch.
// The tokens after "switch" are sub, k and part: "cases", "1", "when".
function switchPlace(
  index: number,
  sub: string | undefined,
  k: string | undefined,
  part: string | undefined,
): Place {
  const step = { on: "step", index } as const;
  if (sub === "otherwise")
    return {
      ...step,
      field: k === "body" ? "otherwise_body" : "otherwise_status",
    };
  if (sub !== "cases" || !isIndex(k)) return { ...step, field: "switch" };
  const field =
    part === "when"
      ? "case_when"
      : part === "body"
        ? "case_body"
        : "case_status";
  return { ...step, field, case: Number(k) };
}

function stepPlace(index: number, [part, sub, name, end]: string[]): Place {
  const step = { on: "step", index } as const;
  if (part === "id" || part === "kind" || part === "expr" || part === "sample")
    return { ...step, field: part };
  if (part === "outputs")
    return !isIndex(sub)
      ? { ...step, field: "outputs" }
      : {
          ...step,
          field: name === "sample" ? "sample" : "outputs",
          output: Number(sub),
        };
  if (part === "switch") return switchPlace(index, sub, name, end);
  if (part === "unhandled") return { ...step, field: "unhandled_body" };
  if (part !== "request") return step;
  if (sub === "headers" || sub === "query")
    return name === undefined
      ? { ...step, field: sub }
      : { ...step, field: sub, name };
  if (sub === "retry")
    return {
      ...step,
      field: name === "idempotent" ? "idempotent" : "attempts",
    };
  return { ...step, field: requestParts.get(sub ?? "") ?? "request" };
}

// stepPartOf is the part of an HTTP step's panel a problem in it is on, as
// the editor's store names parts: a response's, by its block, or adding
// one, or else the request.
export function stepPartOf(place: Place, draft: Definition): string {
  if (place.on !== "step") return "request";
  if (place.output !== undefined) {
    const status = draft.nodes[place.index]?.outputs?.[place.output]?.status;
    return status === undefined ? "add" : String(status);
  }
  if (place.field === "sample") return "2xx";
  if (place.field === "outputs") return "add";
  if (place.field === "unhandled_body") return "unhandled";
  return "request";
}

// follow finds a place, found in one draft, in another. A step is followed
// by its id and a connection by the steps it joins, so a problem stays on
// its step when an earlier one is deleted. A problem is about what was at
// its place when the server looked, so once that has changed, or the step
// was renamed or deleted, or the connection removed, it has no place: the
// next check says whether it's still wrong. A problem with the workflow as
// a whole stays until then.
export function follow(
  place: Place,
  from: Definition,
  to: Definition,
): Place | undefined {
  if (from === to) return place;
  const now = find(place, from, to);
  if (now === undefined || place.on === "workflow") return now;
  const was = partOf(from, place);
  const is = partOf(to, now);
  return was === is || JSON.stringify(was) === JSON.stringify(is)
    ? now
    : undefined;
}

function find(
  place: Place,
  from: Definition,
  to: Definition,
): Place | undefined {
  switch (place.on) {
    case "step": {
      const id = from.nodes[place.index]?.id;
      if (id === undefined) return undefined;
      if (to.nodes[place.index]?.id === id) return place;
      const [now, ...more] = to.nodes.flatMap((n, j) =>
        n.id === id ? [j] : [],
      );
      return now !== undefined && more.length === 0
        ? { ...place, index: now }
        : undefined;
    }
    case "connection": {
      const was = from.edges?.[place.index];
      if (!was) return undefined;
      const same = (e: Edge | undefined) =>
        e?.from === was.from && e?.to === was.to && e?.on === was.on;
      if (same(to.edges?.[place.index])) return place;
      const now = (to.edges ?? []).findIndex(same);
      return now < 0 ? undefined : { ...place, index: now };
    }
    default:
      return place;
  }
}

// partOf is what a place holds in a draft: the text, number or object a
// problem there is about.
function partOf(d: Definition, place: Place): unknown {
  switch (place.on) {
    case "step": {
      const n = d.nodes[place.index];
      const r = n?.request;
      switch (place.field) {
        case undefined:
          return n;
        case "id":
        case "kind":
        case "expr":
          return n?.[place.field];
        case "sample":
          return place.output === undefined
            ? n?.sample
            : n?.outputs?.[place.output]?.sample;
        case "outputs":
          return place.output === undefined
            ? n?.outputs
            : n?.outputs?.[place.output];
        case "request":
          return r;
        case "method":
        case "url":
        case "body":
          return r?.[place.field];
        case "timeout":
          return r?.timeout_ms;
        case "attempts":
        case "idempotent":
          return r?.retry;
        case "headers":
        case "query": {
          const map = r?.[place.field];
          return place.name === undefined ? map : map?.[place.name];
        }
        case "switch":
          return n?.switch;
        case "case_when":
        case "case_status":
        case "case_body": {
          const c = n?.switch?.cases?.[place.case ?? -1];
          return place.field === "case_when"
            ? c?.when
            : place.field === "case_status"
              ? c?.status
              : c?.body;
        }
        case "otherwise_status":
          return n?.switch?.otherwise.status;
        case "otherwise_body":
          return n?.switch?.otherwise.body;
        case "unhandled_body":
          return n?.unhandled?.body;
      }
      return undefined;
    }
    case "connection": {
      const e = d.edges?.[place.index];
      return place.field === undefined ? e : e?.[place.field];
    }
    case "response": {
      const r = d.response;
      const answer = r?.answers?.[place.answer ?? -1];
      switch (place.field) {
        case "output":
        case "output_schema":
          return d[place.field];
        case "answers":
          return r?.answers;
        case "from":
        case "on":
        case "status":
        case "schema":
          return answer?.[place.field];
        case "unhandled":
          return r?.unhandled;
      }
      return undefined;
    }
    case "settings":
      return d[place.field];
    default:
      return d;
  }
}

// The most steps a workflow may have (schema/workflow.yaml).
const MAX_STEPS = 200;

// say is what a problem means, in the screen's words: a step and a
// connection rather than a node and an edge, and what to do about it. Where
// the server's detail is the specific part, such as an expression's syntax
// error or which rule a URL broke, it's shown as sent.
export function say(problem: ProblemError, of: Definition): string {
  const place = placeOf(problem.pointer);
  switch (problem.code) {
    case "required":
      if (
        place.on === "step" &&
        place.field === undefined &&
        of.nodes[place.index]?.kind === "merge"
      )
        return "Draw a line into it from each step it follows: a Merge step runs if any of them comes.";
      return required(place) ?? sentence(problem.detail);
    case "invalid_id":
      return ID_RULE;
    case "duplicate_id":
      return ID_TAKEN;
    case "invalid_kind": {
      const kind = place.on === "step" ? of.nodes[place.index]?.kind : "";
      return `The editor doesn't know steps of the kind “${kind}”.`;
    }
    case "not_allowed": {
      if (tokens(problem.pointer).at(-1) === "unhandled")
        return "A line leaves from one block: one of the step's responses, or its Unhandled.";
      if (place.on === "response") {
        const a = answerOf(place, of);
        return responseNotAllowed(
          place.field,
          a?.unhandled === true,
          kindOf(of, a?.from) === "merge",
        );
      }
      if (place.on === "connection")
        return kindOf(of, of.edges?.[place.index]?.from) === "merge"
          ? "A Merge step has no responses for a connection to leave from."
          : "A transform step has no responses for a connection to leave from.";
      if (place.on === "step" && of.nodes[place.index]?.kind === "merge")
        return mergeNotAllowed(place.field);
      if (place.on === "step" && place.field === "switch")
        return of.nodes[place.index]?.kind === "http"
          ? "An HTTP step sends a request, and has no cases."
          : "A transform step has an expression or cases, not both.";
      if (place.on === "step" && place.field === "expr")
        return "An HTTP step sends a request, and has no expression.";
      if (place.on === "step" && place.field === "sample")
        return place.output === undefined
          ? "A transform step's value comes from its expression, so it has no sample."
          : "A response's sample takes the response's status.";
      if (place.on === "step" && place.field === "outputs")
        return "A transform step gives one value, so it has no other responses.";
      return "A transform step has an expression, and sends no request.";
    }
    case "invalid_status":
      if (
        place.on === "response" ||
        (place.on === "step" &&
          place.field !== "outputs" &&
          place.field !== "sample")
      )
        return "A status from 200 to 599.";
      return place.on === "step" && place.field === "outputs"
        ? "A status from 300 to 599: 2xx is every HTTP step's."
        : "A status from 200 to 299: this is the 2xx response.";
    case "duplicate_output":
      return "This step already has a response for that status.";
    case "duplicate_answer":
      return "Another answer already has this status.";
    case "unknown_answer": {
      const n = place.on === "step" ? of.nodes[place.index] : undefined;
      const status =
        place.on === "step" && place.field === "otherwise_status"
          ? n?.switch?.otherwise.status
          : n?.switch?.cases?.[place.on === "step" ? (place.case ?? -1) : -1]
              ?.status;
      return `${n?.id} isn't joined to a ${status} answer: join it to one on the response card, or pick a status it's joined to.`;
    }
    case "never_given": {
      const a = answerOf(place, of);
      return `${a?.from} never gives ${a?.status}: add a case for it, or join another step to it.`;
    }
    case "overlap":
      return sentence(problem.detail.replace(/one node$/, "one step"));
    case "never_runs":
      // It starts with the step's id, which stays as it's written.
      return `${problem.detail}. A step runs only when every line into it is taken; to run it after whichever comes, join them to a Merge step first.`;
    case "unknown_output": {
      if (place.on === "response") {
        const a = answerOf(place, of);
        return `${a?.from} has no ${a?.on} response. Join this answer from another of its points.`;
      }
      const edge =
        place.on === "connection" ? of.edges?.[place.index] : undefined;
      return `${edge?.from} has no ${edge?.on} response. Add one with + Add on the step, or draw the connection from another.`;
    }
    case "invalid_method":
      return "Pick GET, HEAD, POST, PUT, PATCH or DELETE.";
    case "placeholder_in_host":
      return "Move the {{ }} into the path or the query: the scheme, host and port can't change from run to run.";
    case "invalid_header_name": {
      const name = place.on === "step" ? place.name : "";
      return `“${name}” can't be a header name: use letters, digits and hyphens.`;
    }
    case "invalid_timeout":
      return TIMEOUT_RULE;
    case "invalid_retry":
      return ATTEMPTS_RULE;
    case "self_edge":
      return "A step can't connect to itself.";
    case "duplicate_edge":
      return "Another connection already joins these two steps.";
    case "cycle":
      return "This connection closes a loop, so a step would wait for itself.";
    case "unknown_node": {
      if (place.on === "response")
        return `No step has the id “${answerOf(place, of)?.from}”.`;
      const [, k, end] = tokens(problem.pointer);
      const edge = of.edges?.[Number(k)];
      return `No step has the id “${end === "from" ? edge?.from : edge?.to}”.`;
    }
    case "too_many_nodes":
      return `A workflow has at most ${MAX_STEPS} steps; this one has ${of.nodes.length}.`;
    case "invalid_schema":
      return schemaError(problem.detail);
    default:
      return sentence(problem.detail);
  }
}

// answerOf is the answer a problem in the response is about.
function answerOf(place: Place, of: Definition) {
  return place.on === "response"
    ? of.response?.answers?.[place.answer ?? -1]
    : undefined;
}

// kindOf is the kind of the step with id, if one has it.
function kindOf(of: Definition, id: string | undefined): string | undefined {
  return of.nodes.find((n) => n.id === id)?.kind;
}

// mergeNotAllowed is what's wrong with a part of a Merge step that other
// kinds have.
function mergeNotAllowed(field: StepField | undefined): string {
  switch (field) {
    case "switch":
      return "A Merge step has an expression, not cases.";
    case "sample":
      return "A Merge step's value comes from its expression, so it has no sample.";
    case "outputs":
      return "A Merge step gives one value, so it has no other responses.";
    default:
      return "A Merge step has an expression, and sends no request.";
  }
}

// responseNotAllowed is what's wrong with the part of the response a
// not_allowed problem is about, in an answer joined to a step's Unhandled
// when unhandled says so, or to a Merge step when merge does.
function responseNotAllowed(
  field: ResponseField,
  unhandled: boolean,
  merge: boolean,
): string {
  switch (field) {
    case "on":
      return merge
        ? "A Merge step has one point, so its line into an answer names no response."
        : "A transform step has one point, so its line into an answer names no response.";
    case "from":
      return unhandled
        ? "A step's Unhandled has no status to pick an answer with, so it gives one. To pick among several, join a transform step that does."
        : "An HTTP step's response is what it got, so each of its responses gives one answer. To pick among several, join a transform step that does.";
    default:
      return "A workflow with a response has no output: the steps joined to its answers give them.";
  }
}

function required(place: Place): string | undefined {
  if (place.on === "connection")
    return "A connection needs a step at each end.";
  if (place.on === "response")
    switch (place.field) {
      case "from":
        return "Join a step to this answer: drag from the step's point to the answer's.";
      case "answers":
        return "Add an answer: a status the API gives.";
      case "status":
        return "Give the answer a status.";
      case "unhandled":
        return "Write its body, or use Conduit's problem details instead.";
      default:
        return undefined;
    }
  if (place.on !== "step") return undefined;
  switch (place.field) {
    case "id":
      return "Give the step an id.";
    case "kind":
      return "Give the step a kind: HTTP, transform or Merge.";
    case "request":
      return "An HTTP step needs a request.";
    case "expr":
      return "Add an expression.";
    case "unhandled_body":
      return "Write its body, or give what the step got instead.";
    case "method":
      return "Pick a method.";
    case "url":
      return "Add a URL.";
    case "sample":
      return "Add the sample's body; null for none.";
    case "outputs":
      return "Give the response a status.";
    case "case_when":
      return "Add a condition.";
    case "case_status":
    case "otherwise_status":
      return "Give it a status.";
    default:
      return undefined;
  }
}

// schemaError picks, from the schema compiler's report, the first line that
// says what's wrong rather than which rule failed: "- at '/type': value must
// be one of …". The report opens with the schema's made-up base URL, which
// means nothing here. A report of another shape is shown as it is.
function schemaError(detail: string): string {
  for (const line of detail.split("\n")) {
    const [, at, what] = /^\s*- at '([^']*)': (.*)$/.exec(line) ?? [];
    if (what === undefined || /^'\w+' failed$/.test(what)) continue;
    return sentence(
      `Not a valid JSON Schema: ${at ? `at ${at}, ` : ""}${what}`,
    );
  }
  return sentence(detail);
}

// sentence makes the server's detail, written as a Go error, a sentence: a
// capital first and a full stop last.
function sentence(text: string): string {
  const s = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

// The order of the problems list: steps in the definition's order, then
// connections, the response, the settings and the workflow as a whole.
const order = { step: 0, connection: 1, response: 2, settings: 3, workflow: 4 };

function rank(p: Place): [number, number] {
  return [order[p.on], "index" in p ? p.index : 0];
}

// Kept per draft, so every selector reading the problems in one render
// shares one list, and a list that hasn't changed keeps its identity.
const placed = new WeakMap<Definition, { check: Check; found: Found[] }>();

// problemsIn is what a check found, placed in the draft as it is now. A
// problem whose place has gone since waits for the next check.
export function problemsIn(check: Check, draft: Definition): Found[] {
  const kept = placed.get(draft);
  if (kept?.check === check) return kept.found;
  const found = check.problems
    .flatMap((p) => {
      const place = follow(placeOf(p.pointer), check.of, draft);
      return place ? [{ place, code: p.code, message: say(p, check.of) }] : [];
    })
    .sort((a, b) => {
      const [x, i] = rank(a.place);
      const [y, j] = rank(b.place);
      return x - y || i - j;
    });
  placed.set(draft, { check, found });
  return found;
}
