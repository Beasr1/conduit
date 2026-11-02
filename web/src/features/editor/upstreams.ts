import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type Node = Definition["nodes"][number];
type Upstream = components["schemas"]["Upstream"];
type Uses = components["schemas"]["Uses"];
type Parameter = components["schemas"]["Parameter"];

// versionKey names a version of an upstream: "id@3".
export const versionKey = (uses: Uses) => `${uses.upstream}@${uses.version}`;

// fill gives each node that uses an upstream its version's request,
// responses and samples, as the server does (plan 07), so the editor draws
// and edits it as any HTTP step. A version it hasn't got leaves the node as
// it is, and the server's check says why.
export function fill(
  d: Definition,
  versions: Record<string, Upstream>,
): Definition {
  let changed = false;
  const nodes = d.nodes.map((n) => {
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
