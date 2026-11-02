import { useQueryClient } from "@tanstack/react-query";

import { Hint } from "@/components/hint";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { METHODS } from "@/features/editor/fields";
import { useEditor } from "@/features/editor/store";
import { asUpstream, fill, pin, versionKey } from "@/features/editor/upstreams";
import {
  fetchLatest,
  useCreateUpstream,
  useUpstreams,
} from "@/features/upstreams/hooks/use-upstreams";
import type { components } from "@/gen/schema";
import { ApiError } from "@/lib/api";

type Node = components["schemas"]["Node"];
type Method = components["schemas"]["HTTPRequest"]["method"];

// NEW is the choice of an upstream made in the dialog, from a call.
export const NEW = "new";

// Choice is what Add HTTP step's Upstream field holds (plan 07): an
// upstream of the library's, by its id, or NEW, with the name and call to
// make one from; null until one is picked.
export interface Choice {
  upstream: string | null;
  name: string;
  method: Method;
  url: string;
}

export const NO_CHOICE: Choice = {
  upstream: null,
  name: "",
  method: "GET",
  url: "",
};

// Said is what's wrong with a choice, by the field it shows under.
export type Said = Partial<Record<"upstream" | "name" | "url", string>>;

// UpstreamChoice picks the upstream a new HTTP step uses: one from the
// library, or a new one, made from a name and a call whose URL reads the
// run, as a step's own request did.
export function UpstreamChoice({
  choice,
  onChange,
  said,
}: {
  choice: Choice;
  onChange: (choice: Choice) => void;
  said: Said;
}) {
  const upstreams = useUpstreams();
  const list = upstreams.data?.pages.flatMap((p) => p.upstreams) ?? [];
  const nameOf = (id: string | null) =>
    id === NEW
      ? "New upstream"
      : (list.find((u) => u.id === id)?.name ?? "Pick an upstream");
  return (
    <>
      <Field data-invalid={!!said.upstream}>
        <div className="flex items-center gap-1">
          <FieldLabel htmlFor="new-http-upstream">Upstream</FieldLabel>
          <Hint about="Upstream">
            An API from the library, which the step calls at its latest version,
            or a new one made from a call.
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
          <SelectContent>
            {list.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
            <SelectItem value={NEW}>New upstream</SelectItem>
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
        </>
      )}
    </>
  );
}

// useMakeStep makes the HTTP step a choice says (plan 07): one that uses an
// upstream of the library's, at its latest version; or a new upstream,
// made from the call as Save as upstream makes one, each placeholder a
// parameter the step gives what it read.
export function useMakeStep() {
  const client = useQueryClient();
  const create = useCreateUpstream();
  const addVersion = useEditor((s) => s.addVersion);
  return async (
    id: string,
    choice: Choice,
  ): Promise<{ node: Node } | { said: Said }> => {
    if (choice.upstream === null)
      return { said: { upstream: "Pick an upstream, or make a new one." } };
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
    const said: Said = {};
    if (choice.name.trim() === "") said.name = "Give it a name.";
    if (choice.url.trim() === "") said.url = "Add a URL.";
    if (said.name !== undefined || said.url !== undefined) return { said };
    const { upstream, with: given } = asUpstream({
      id,
      kind: "http",
      request: { method: choice.method, url: choice.url.trim() },
    });
    try {
      const made = await create.mutateAsync({
        name: choice.name.trim(),
        definition: upstream,
      });
      const uses = { upstream: made.upstream.id, version: made.version };
      addVersion(versionKey(uses), made.definition);
      return {
        node: pin({ id, kind: "http", with: given }, uses, made.definition),
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
