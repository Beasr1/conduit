import { useQueryClient } from "@tanstack/react-query";

import { Hint } from "@/components/hint";
import {
  checkSamples,
  NO_SAMPLES,
  type Samples,
  type SamplesSaid,
  says,
  UpstreamSamples,
  withSamples,
} from "@/components/upstream-samples";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { METHODS } from "@/features/editor/fields";
import { useEditor } from "@/features/editor/store";
import { asUpstream, fill, pin, versionKey } from "@/features/editor/upstreams";
import {
  fetchLatest,
  fetchServed,
  useCreateUpstream,
  useUpstreams,
} from "@/features/upstreams/hooks/use-upstreams";
import { useWorkflows } from "@/features/workflows/hooks/use-workflows";
import type { components } from "@/gen/schema";
import { ApiError } from "@/lib/api";

type Node = components["schemas"]["Node"];
type Method = components["schemas"]["HTTPRequest"]["method"];

// NEW is the choice of an upstream made in the dialog, from a call.
export const NEW = "new";
// WF and a workflow's id is the choice of a published workflow.
export const WF = "wf:";

// Choice is what Add HTTP step's Upstream field holds (plan 07): an
// upstream of the library's, by its id; a published workflow, WF and its
// id; or NEW, with the name, call and samples to make one from; null until
// one is picked.
export interface Choice {
  upstream: string | null;
  name: string;
  method: Method;
  url: string;
  samples: Samples;
}

export const NO_CHOICE: Choice = {
  upstream: null,
  name: "",
  method: "GET",
  url: "",
  samples: NO_SAMPLES,
};

// Said is what's wrong with a choice, by the field it shows under.
export type Said = Partial<Record<"upstream" | "name" | "url", string>> & {
  samples?: SamplesSaid;
};

// made is the upstream a choice of NEW makes, and what the step gives its
// parameters: the call as a step's own request, each placeholder a
// parameter given what it read (asUpstream).
const made = (id: string, choice: Choice) =>
  asUpstream({
    id,
    kind: "http",
    request: { method: choice.method, url: choice.url.trim() },
  });

// UpstreamChoice picks the upstream a new HTTP step uses: one from the
// library; a published workflow, but not self, the one it's added to; or a
// new one, made from a name and a call whose URL reads the run, as a
// step's own request did.
export function UpstreamChoice({
  choice,
  onChange,
  said,
  self,
}: {
  choice: Choice;
  onChange: (choice: Choice) => void;
  said: Said;
  self: string;
}) {
  const upstreams = useUpstreams();
  const list = upstreams.data?.pages.flatMap((p) => p.upstreams) ?? [];
  const workflows = useWorkflows();
  const served = (
    workflows.data?.pages.flatMap((p) => p.workflows) ?? []
  ).filter((w) => w.published_revision !== undefined && w.id !== self);
  const nameOf = (id: string | null) =>
    id === NEW
      ? "New upstream"
      : ((id?.startsWith(WF)
          ? served.find((w) => WF + w.id === id)?.name
          : list.find((u) => u.id === id)?.name) ?? "Pick an upstream");
  return (
    <>
      <Field data-invalid={!!said.upstream}>
        <div className="flex items-center gap-1">
          <FieldLabel htmlFor="new-http-upstream">Upstream</FieldLabel>
          <Hint about="Upstream">
            An API from the library, which the step calls at its latest version;
            a published workflow, which it runs at the revision served; or a new
            upstream made from a call.
          </Hint>
        </div>
        <Select<string | null>
          value={choice.upstream}
          onValueChange={(upstream) => onChange({ ...choice, upstream })}
        >
          <SelectTrigger
            id="new-http-upstream"
            className="w-full"
            aria-invalid={!!said.upstream}
          >
            <SelectValue placeholder="Pick an upstream">{nameOf}</SelectValue>
          </SelectTrigger>
          {/* Each part a group, so all of them line up. */}
          <SelectContent>
            {list.length > 0 && (
              <SelectGroup>
                <SelectLabel>Upstreams</SelectLabel>
                {list.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {served.length > 0 && (
              <SelectGroup>
                <SelectLabel>Workflows</SelectLabel>
                {served.map((w) => (
                  <SelectItem key={w.id} value={WF + w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            <SelectGroup>
              <SelectItem value={NEW}>New upstream</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {said.upstream && <FieldError>{said.upstream}</FieldError>}
      </Field>
      {choice.upstream === NEW && (
        <>
          <Field data-invalid={!!said.name}>
            <FieldLabel htmlFor="new-http-upstream-name">Name</FieldLabel>
            <Input
              id="new-http-upstream-name"
              placeholder="Users API"
              aria-invalid={!!said.name}
              value={choice.name}
              onChange={(e) => onChange({ ...choice, name: e.target.value })}
            />
            {said.name && <FieldError>{said.name}</FieldError>}
          </Field>
          <Field data-invalid={!!said.url}>
            <div className="flex items-center gap-1">
              <FieldLabel htmlFor="new-http-upstream-url">URL</FieldLabel>
              <Hint about="URL">
                Absolute, http or https. {"{{ }}"} holds JSONata over the run,
                as <span className="font-mono">{"{{ input.user_id }}"}</span>:
                each becomes a parameter of the upstream, which the step gives
                what it read.
              </Hint>
            </div>
            <div className="flex gap-2">
              <Select<Method>
                value={choice.method}
                onValueChange={(method) =>
                  method && onChange({ ...choice, method })
                }
              >
                <SelectTrigger aria-label="Method" className="font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m} value={m} className="font-mono">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id="new-http-upstream-url"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://api.example.com/v1/users/{{ input.user_id }}"
                aria-invalid={!!said.url}
                value={choice.url}
                onChange={(e) => onChange({ ...choice, url: e.target.value })}
              />
            </div>
            {said.url && <FieldError>{said.url}</FieldError>}
          </Field>
          <UpstreamSamples
            id="new-http-upstream"
            value={choice.samples}
            onChange={(samples) => onChange({ ...choice, samples })}
            parameters={(made("", choice).upstream.parameters ?? []).map(
              (p) => p.name,
            )}
            said={said.samples ?? { responses: [] }}
          />
        </>
      )}
    </>
  );
}

// useMakeStep makes the HTTP step a choice says (plan 07): one that uses an
// upstream of the library's, at its latest version; one that uses a
// workflow, at the revision it serves; or a new upstream,
// made from the call as Save as upstream makes one, each placeholder a
// parameter the step gives what it read, with its samples.
export function useMakeStep() {
  const client = useQueryClient();
  const create = useCreateUpstream();
  const addVersion = useEditor((s) => s.addVersion);
  const addCalled = useEditor((s) => s.addCalled);
  return async (
    id: string,
    choice: Choice,
  ): Promise<{ node: Node } | { said: Said }> => {
    if (choice.upstream === null)
      return { said: { upstream: "Pick an upstream, or make a new one." } };
    if (choice.upstream.startsWith(WF)) {
      try {
        const { uses, called } = await fetchServed(
          client,
          choice.upstream.slice(WF.length),
        );
        addCalled(versionKey(uses), called);
        return {
          node: fill(
            { nodes: [{ id, kind: "http", uses }] },
            {},
            { [versionKey(uses)]: called },
          ).nodes[0]!,
        };
      } catch {
        return { said: { upstream: "Couldn't load the workflow. Try again." } };
      }
    }
    if (choice.upstream !== NEW) {
      try {
        const latest = await fetchLatest(client, choice.upstream);
        const uses = { upstream: choice.upstream, version: latest.version };
        addVersion(versionKey(uses), latest.definition);
        return {
          node: fill(
            { nodes: [{ id, kind: "http", uses }] },
            { [versionKey(uses)]: latest.definition },
          ).nodes[0]!,
        };
      } catch {
        return { said: { upstream: "Couldn't load the upstream. Try again." } };
      }
    }
    const { upstream, with: given } = made(id, choice);
    const said: Said = {};
    if (choice.name.trim() === "") said.name = "Give it a name.";
    if (choice.url.trim() === "") said.url = "Add a URL.";
    const samples = checkSamples(
      choice.samples,
      (upstream.parameters ?? []).map((p) => p.name),
    );
    if (says(samples)) said.samples = samples;
    if (
      said.name !== undefined ||
      said.url !== undefined ||
      said.samples !== undefined
    )
      return { said };
    try {
      const saved = await create.mutateAsync({
        name: choice.name.trim(),
        definition: withSamples(upstream, choice.samples),
      });
      const uses = { upstream: saved.upstream.id, version: saved.version };
      addVersion(versionKey(uses), saved.definition);
      return {
        node: pin({ id, kind: "http", with: given }, uses, saved.definition),
      };
    } catch (err) {
      return { said: saidOf(err) };
    }
  };
}

// saidOf is what the server said of a new upstream, under its field.
function saidOf(err: unknown): Said {
  if (!(err instanceof ApiError))
    return { upstream: "Couldn't make the upstream. Try again." };
  if (err.status === 409) return { name: "An upstream already has that name." };
  const said: Said = {};
  for (const e of err.problem?.errors ?? []) {
    if (e.pointer === "/name") said.name ??= e.detail;
    else if (e.pointer.startsWith("/definition/request")) said.url ??= e.detail;
  }
  return said.name !== undefined || said.url !== undefined
    ? said
    : { upstream: err.message };
}
