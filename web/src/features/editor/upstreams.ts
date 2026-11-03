import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type Node = Definition["nodes"][number];
type Upstream = components["schemas"]["Upstream"];
type Uses = components["schemas"]["Uses"];
type Parameter = components["schemas"]["Parameter"];

// versionKey names what a step pins (plan 07): a version of an upstream,
// "id@3", or a revision of a workflow, "wf:id@3".
export const versionKey = (uses: Uses) =>
  uses.workflow !== undefined
    ? `wf:${uses.workflow}@${uses.revision}`
    : `${uses.upstream}@${uses.version}`;

// Called is a revision of a workflow a step uses (plan 07): the workflow's
// name, the revision it serves now, if any, and the revision itself.
export interface Called {
  name: string;
  published: number | undefined;
  definition: Definition;
}

// answersOf is a workflow's answers besides 2xx, each once, in order: the
// responses of a step that uses it, beside its 2xx, as the server has them.
export function answersOf(d: Definition): { status: number }[] | undefined {
  const statuses = [
    ...new Set(
      (d.response?.answers ?? []).map((a) => a.status).filter((s) => s >= 300),
    ),
  ];
  return statuses.length > 0
    ? statuses.map((status) => ({ status }))
    : undefined;
}

// inputOf is the fields of the input a workflow takes, which a step that
// uses it gives values, as the server has them: its input schema's
// properties, the required ones required; with none, its sample input's
// fields; with neither, none. By name.
export function inputOf(d: Definition): {
  fields: string[];
  required: Set<string>;
} {
  const schema = d.input_schema;
  const props = schema?.properties;
  if (typeof props === "object" && props !== null && !Array.isArray(props)) {
    const req = Array.isArray(schema?.required) ? schema.required : [];
    return {
      fields: Object.keys(props).sort(),
      required: new Set(req.filter((r): r is string => typeof r === "string")),
    };
  }
  const sample = d.sample_input;
  if (typeof sample === "object" && sample !== null && !Array.isArray(sample))
    return { fields: Object.keys(sample).sort(), required: new Set() };
  return { fields: [], required: new Set() };
}

// fill gives each node that uses an upstream its version's request,
// responses and samples, as the server does (plan 07), so the editor draws
// and edits it as any HTTP step. A version it hasn't got leaves the node as
// it is, and the server's check says why.
export function fill(
  d: Definition,
  versions: Record<string, Upstream>,
  called: Record<string, Called> = {},
): Definition {
  let changed = false;
  const nodes = d.nodes.map((n) => {
    if (n.uses?.workflow !== undefined) {
      // A step that uses a workflow has its answers as its responses.
      const c = called[versionKey(n.uses)];
      if (!c) return n;
      changed = true;
      return withoutOwn({ ...n, outputs: answersOf(c.definition) });
    }
    const u = n.uses && versions[versionKey(n.uses)];
    if (!u) return n;
    changed = true;
    return withoutOwn({
      ...n,
      request: u.request,
      outputs: u.outputs,
      sample: u.sample,
    });
  });
  return changed ? { ...d, nodes } : d;
}

// strip takes back what fill gave: a node that uses an upstream has no
// request, responses or samples of its own. The draft is filled; what the
// server is sent, stripped.
export function strip(d: Definition): Definition {
  if (!d.nodes.some((n) => n.uses && (n.request || n.outputs || n.sample)))
    return d;
  return {
    ...d,
    nodes: d.nodes.map((n) =>
      n.uses ? without(n, ["request", "outputs", "sample"]) : n,
    ),
  };
}

// withoutOwn drops fields fill set to nothing, so a filled node reads as
// the server's JSON would.
function withoutOwn(n: Node): Node {
  return without(
    n,
    (["outputs", "sample"] as const).filter((k) => n[k] === undefined),
  );
}

// without is a copy of o with keys left out.
export function without<T extends object>(o: T, keys: readonly (keyof T)[]): T {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

// pinCalled moves node to uses, a workflow's revision, filled from c: the
// values it gives the fields c still takes stay, and the rest go.
export function pinCalled(n: Node, uses: Uses, c: Called): Node {
  const { fields } = inputOf(c.definition);
  const kept = Object.entries(n.with ?? {}).filter(([name]) =>
    fields.includes(name),
  );
  const out: Node = {
    ...without(n, ["request", "outputs", "sample", "with"]),
    uses,
  };
  if (kept.length > 0) out.with = Object.fromEntries(kept);
  const outputs = answersOf(c.definition);
  if (outputs) out.outputs = outputs;
  return out;
}

// pin moves node to uses, filled from u, that version: the values it gives
// parameters u still has stay, and the rest go.
export function pin(n: Node, uses: Uses, u: Upstream): Node {
  const names = new Set((u.parameters ?? []).map((p) => p.name));
  const kept = Object.entries(n.with ?? {}).filter(([name]) => names.has(name));
  const out: Node = {
    ...without(n, ["request", "outputs", "sample", "with"]),
    uses,
    request: u.request,
  };
  if (kept.length > 0) out.with = Object.fromEntries(kept);
  if (u.outputs) out.outputs = u.outputs;
  if (u.sample) out.sample = u.sample;
  return out;
}

// upstreamOf is the version a filled node would save: its parameters, and
// its request, responses and samples as they stand.
export function upstreamOf(n: Node, parameters: Parameter[]): Upstream {
  const u: Upstream = {
    parameters,
    request: n.request ?? { method: "GET", url: "" },
  };
  if (n.outputs) u.outputs = n.outputs;
  if (n.sample) u.sample = n.sample;
  return u;
}

// sameUpstream says whether built, as upstreamOf builds an upstream, is
// saved, so a save of it would change nothing. As JSON: what hasn't been
// touched keeps saved's order.
export function sameUpstream(built: Upstream, saved: Upstream): boolean {
  const normal: Upstream = {
    parameters: saved.parameters ?? [],
    request: saved.request,
  };
  if (saved.outputs) normal.outputs = saved.outputs;
  if (saved.sample) normal.sample = saved.sample;
  return JSON.stringify(built) === JSON.stringify(normal);
}

// A placeholder in a template: {{ expression }}, ending at the first }}.
const PLACEHOLDER = /\{\{([\s\S]*?)\}\}/g;
// An expression that's a plain path, a.b.c, names its parameter for its
// last field.
const PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
// A bare name, as a parameter's is.
const BARE = /^[a-z][a-z0-9_]{0,63}$/;

// asUpstream turns a step's own request into an upstream (Save as upstream):
// each placeholder becomes a parameter, named for what it reads, which the
// step gives what it read, the same expression one parameter; a body
// becomes the parameter body. A placeholder that's a bare name, as an
// upstream's own are, reads nothing of the run, whose fields are input and
// nodes, so it's a parameter of that name still to be given a value. Its
// responses and samples go with it.
export function asUpstream(n: Node): {
  upstream: Upstream;
  with: Record<string, string>;
} {
  const parameters: Parameter[] = [];
  const given: Record<string, string> = {};
  const named = new Map<string, string>(); // expression to parameter
  const name = (expr: string, wanted: string) => {
    const known = named.get(expr);
    if (known) return known;
    let p = wanted;
    for (let k = 2; parameters.some((q) => q.name === p); k++)
      p = `${wanted}_${k}`;
    named.set(expr, p);
    if (!BARE.test(expr) || expr === "input" || expr === "nodes")
      given[p] = expr;
    parameters.push({ name: p });
    return p;
  };
  const template = (src: string) =>
    src.replace(PLACEHOLDER, (_all, inner: string) => {
      const expr = inner.trim();
      return `{{ ${name(expr, nameFor(expr))} }}`;
    });
  const templates = (m: Record<string, string> | undefined) =>
    m &&
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, template(v)]));

  const r = n.request ?? { method: "GET" as const, url: "" };
  const request = { ...r, url: template(r.url) };
  if (r.headers) request.headers = templates(r.headers);
  if (r.query) request.query = templates(r.query);
  if (r.body) request.body = name(r.body, "body");
  const upstream: Upstream = { parameters, request };
  if (n.outputs) upstream.outputs = n.outputs;
  if (n.sample) upstream.sample = n.sample;
  return { upstream, with: given };
}

// nameFor is a parameter's name for what it reads: a path's last field,
// lowercased as names are, or value.
function nameFor(expr: string): string {
  if (!PATH.test(expr)) return "value";
  const last = (expr.split(".").at(-1) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 64);
  return /^[a-z]/.test(last) ? last : "value";
}
