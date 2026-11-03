import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";

import { Button, buttonVariants } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  JsonBlock,
  MappingField,
  Skipped,
} from "@/features/editor/components/mapping-field";
import { Sends } from "@/features/editor/components/step-body";
import { parents, updateNode } from "@/features/editor/edits";
import {
  asErrors,
  atStep,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";
import {
  inputOf,
  pin,
  pinCalled,
  sameUpstream,
  upstreamOf,
  versionKey,
} from "@/features/editor/upstreams";
import {
  fetchCalled,
  fetchVersion,
  useSaveUpstream,
  useUpstream,
  useUsedWorkflow,
} from "@/features/editor/hooks/use-upstreams";
import type { components } from "@/gen/schema";
import { ApiError } from "@/lib/api";
import { routes } from "@/router";

type Preview = components["schemas"]["Preview"];

// A parameter's name, as an upstream names it (plan 07).
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

// UpstreamLine says which upstream a step uses, at which version, offers a
// newer one, and edits the upstream in place (plan 07): Edit unlocks the
// step's request and responses, previewed over this workflow, Save upstream
// makes the next version, which the step moves to, once something's
// changed, and Discard puts the pinned version back. A step pinned to an
// older version takes the newest before it's edited, so an edit never
// undoes another.
export function UpstreamLine({ index }: { index: number }) {
  const uses = useEditor((s) => s.draft.nodes[index]?.uses);
  const upstream = uses?.upstream ?? "";
  const version = uses?.version ?? 0;
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const pinned = useEditor((s) =>
    uses ? s.versions[versionKey(uses)] : undefined,
  );
  const editing = useEditor((s) => s.upstreamEdit?.node === id);
  const unchanged = useEditor((s) => {
    const n = s.draft.nodes[index];
    const parameters = s.upstreamEdit?.parameters;
    return (
      !n ||
      !parameters ||
      !pinned ||
      sameUpstream(upstreamOf(n, parameters), pinned)
    );
  });
  const editUpstream = useEditor((s) => s.editUpstream);
  const addVersion = useEditor((s) => s.addVersion);
  const edit = useEditor((s) => s.edit);
  const editor = useEditorStore();
  const client = useQueryClient();
  const library = useUpstream(upstream);
  const save = useSaveUpstream();
  const problems = useProblems(atStep(index, "uses"));
  const [failed, setFailed] = useState<string[]>([]);
  if (!uses) return null;
  const name = library.data?.upstream.name ?? upstream;
  const latest = library.data?.version;
  const newer = latest !== undefined && latest > version;

  async function take(next: number) {
    const to = { upstream, version: next };
    const v = await fetchVersion(client, to);
    addVersion(versionKey(to), v.definition);
    edit((d) => updateNode(d, index, (n) => pin(n, to, v.definition)));
  }

  async function saveUpstream() {
    const state = editor.getState();
    const node = state.draft.nodes[index];
    const parameters = state.upstreamEdit?.parameters;
    if (!uses || !node || !parameters) return;
    try {
      const saved = await save.mutateAsync({
        id: upstream,
        base: version,
        upstream: upstreamOf(node, parameters),
      });
      const to = { upstream, version: saved.version };
      addVersion(versionKey(to), saved.definition);
      edit((d) => updateNode(d, index, (n) => pin(n, to, saved.definition)));
      editUpstream(undefined);
      setFailed([]);
    } catch (err) {
      setFailed(
        err instanceof ApiError && err.status === 412
          ? [
              "Another version was saved first. Discard, take it, and edit again.",
            ]
          : err instanceof ApiError && err.problem?.errors?.length
            ? err.problem.errors.map((e) => `${e.pointer}: ${e.detail}`)
            : ["Couldn't save the upstream. Try again."],
      );
    }
  }

  function discard() {
    if (uses && pinned)
      edit((d) => updateNode(d, index, (n) => pin(n, uses, pinned)));
    editUpstream(undefined);
    setFailed([]);
  }

  return (
    <section
      id="step-upstream"
      aria-label="Upstream"
      className="flex flex-col gap-2 rounded-md border p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-medium">{name}</span>{" "}
          <span className="text-muted-foreground">· v{version}</span>
        </p>
        <div className="flex gap-1">
          {editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={discard}>
                Discard
              </Button>
              <Button
                size="sm"
                onClick={() => void saveUpstream()}
                disabled={save.isPending || unchanged}
              >
                Save upstream
              </Button>
            </>
          ) : newer ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void take(latest)}
            >
              Use v{latest}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!pinned}
              onClick={() =>
                pinned &&
                editUpstream({ node: id, parameters: pinned.parameters ?? [] })
              }
            >
              Edit upstream
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <p className="text-muted-foreground">
          Its request and responses are open. Save upstream makes v{version + 1}
          , which this step then uses.
        </p>
      )}
      <FieldError
        errors={[
          ...asErrors(problems),
          ...failed.map((message) => ({ message })),
        ]}
      />
    </section>
  );
}

// WorkflowLine says which workflow a step uses, at which revision, offers
// the one it serves when that's newer, and opens it (plan 07). A workflow
// is edited on its own page, so there's no editing in place.
export function WorkflowLine({ index }: { index: number }) {
  const uses = useEditor((s) => s.draft.nodes[index]?.uses);
  const addCalled = useEditor((s) => s.addCalled);
  const edit = useEditor((s) => s.edit);
  const client = useQueryClient();
  const workflow = uses?.workflow ?? "";
  const revision = uses?.revision ?? 0;
  const used = useUsedWorkflow(workflow);
  const problems = useProblems(atStep(index, "uses"));
  const [failed, setFailed] = useState<string[]>([]);
  if (!uses) return null;
  const name = used.data?.workflow.name ?? workflow;
  const served = used.data?.workflow.published_revision;

  async function take(next: number) {
    const to = { workflow, revision: next };
    try {
      const c = await fetchCalled(client, to);
      addCalled(versionKey(to), c);
      edit((d) => updateNode(d, index, (n) => pinCalled(n, to, c)));
      setFailed([]);
    } catch {
      setFailed([`Couldn't get revision ${next}. Try again.`]);
    }
  }

  return (
    <section
      id="step-upstream"
      aria-label="Workflow"
      className="flex flex-col gap-2 rounded-md border p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-medium">{name}</span>{" "}
          <span className="text-muted-foreground">· r{revision}</span>
        </p>
        <div className="flex gap-1">
          {served !== undefined && served > revision && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void take(served)}
            >
              Use r{served}
            </Button>
          )}
          <Link
            to={routes.workflow(workflow)}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open workflow
          </Link>
        </div>
      </div>
      <FieldError
        errors={[
          ...asErrors(problems),
          ...failed.map((message) => ({ message })),
        ]}
      />
    </section>
  );
}

// StepInput gives each field of the input the workflow a step uses takes a
// value, JSONata over the run, previewed as what the step gives it and the
// answer it gets back, from the workflow's own preview (plan 07). A field
// left empty takes the workflow's sample in previews, and a required one is
// what Publish asks for.
export function StepInput({ index }: { index: number }) {
  const definition = useEditor((s) => {
    const uses = s.draft.nodes[index]?.uses;
    return uses ? s.called[versionKey(uses)]?.definition : undefined;
  });
  if (!definition)
    return (
      <p className="text-sm text-muted-foreground">
        The revision it uses didn&apos;t load, so its input isn&apos;t known.
      </p>
    );
  const { fields, required } = inputOf(definition);
  const sample = definition.sample_input;
  const samples =
    typeof sample === "object" && sample !== null && !Array.isArray(sample)
      ? (sample as Record<string, unknown>)
      : {};
  return (
    <div className="flex flex-col gap-5">
      {fields.length === 0 && (
        <p className="text-sm text-muted-foreground">
          The workflow takes no input.
        </p>
      )}
      {fields.map((name) => (
        <InputField
          key={name}
          index={index}
          name={name}
          required={required.has(name)}
          sample={Object.hasOwn(samples, name) ? samples[name] : undefined}
        />
      ))}
    </div>
  );
}

// InputField is one field of a workflow's input: JSONata over the run,
// which the workflow reads as input.name.
function InputField({
  index,
  name,
  required,
  sample,
}: {
  index: number;
  name: string;
  required: boolean;
  sample: unknown;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const preview = usePreview({ step: index });
  const problems = useProblems(
    (p) =>
      p.on === "step" &&
      p.index === index &&
      p.field === "with" &&
      p.name === name,
  );
  return (
    <MappingField
      id={`step-with-${name}`}
      label={name}
      hint={
        <>
          JSONata over the input. The workflow reads it as{" "}
          <span className="font-mono">input.{name}</span>.{" "}
          {required ? "Required: Publish asks for it. " : ""}
          {sample === undefined
            ? "Left empty, previews give it nothing."
            : `Left empty, previews give it the workflow's sample, ${JSON.stringify(sample)}.`}
        </>
      }
      placeholder={`input.${name}`}
      initial={editor.getState().draft.nodes[index]?.with?.[name] ?? ""}
      apply={(text) =>
        edit((d) =>
          updateNode(d, index, (n) => ({
            ...n,
            with: { ...n.with, [name]: text },
          })),
        )
      }
      problems={problems}
      preview={preview}
      open={(of) => parents(of, of.nodes[index]?.id)}
      result={(p) => <Calls preview={p} />}
    />
  );
}

// Calls is what a step that uses a workflow gives it, the values of its
// input's fields, and the answer it gets back, as the workflow's own
// preview gives it.
function Calls({ preview: p }: { preview: Preview }) {
  if (p.skipped) return <Skipped />;
  const gets = p.gives as { status: number; body?: unknown } | undefined;
  return (
    <>
      <h3 className="font-medium">Gives</h3>
      <JsonBlock value={p.parameters ?? {}} />
      <h3 className="font-medium">Gets</h3>
      {gets === undefined ? (
        <p className="text-muted-foreground">
          Nothing: the workflow&apos;s preview reaches no answer.
        </p>
      ) : (
        <>
          <p className="font-mono">{gets.status}</p>
          <JsonBlock value={gets.body ?? null} />
        </>
      )}
    </>
  );
}

// StepParameters gives each parameter of the upstream a step uses a value,
// JSONata over the run, previewed as the request it makes. While the
// upstream is edited, parameters can be added and removed.
export function StepParameters({ index }: { index: number }) {
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const edit = useEditor((s) => s.upstreamEdit);
  const editUpstream = useEditor((s) => s.editUpstream);
  const pinned = useEditor((s) => {
    const uses = s.draft.nodes[index]?.uses;
    return uses ? s.versions[versionKey(uses)] : undefined;
  });
  const editing = edit?.node === id;
  const names = (editing ? edit.parameters : (pinned?.parameters ?? [])).map(
    (p) => p.name,
  );
  const [added, setAdded] = useState("");
  const taken = names.includes(added);

  return (
    <div className="flex flex-col gap-5">
      {names.length === 0 && (
        <p className="text-sm text-muted-foreground">
          The upstream takes no parameters.
        </p>
      )}
      {names.map((name) => (
        <div key={name} className="flex flex-col gap-1">
          <ParameterField index={index} name={name} />
          {editing && (
            <Button
              variant="ghost"
              size="xs"
              className="self-end"
              aria-label={`Remove the parameter ${name}`}
              onClick={() =>
                editUpstream({
                  node: id,
                  parameters: edit.parameters.filter((p) => p.name !== name),
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {editing && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!NAME.test(added) || taken) return;
            editUpstream({
              node: id,
              parameters: [...edit.parameters, { name: added }],
            });
            setAdded("");
          }}
        >
          <Input
            aria-label="Add a parameter"
            className="font-mono"
            placeholder="user_id"
            value={added}
            onChange={(e) => setAdded(e.target.value)}
          />
          <Button type="submit" variant="outline" size="sm">
            Add
          </Button>
        </form>
      )}
    </div>
  );
}

// ParameterField is one parameter's value: JSONata over the input, which
// the upstream's request reads by the parameter's name.
function ParameterField({ index, name }: { index: number; name: string }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const preview = usePreview({ step: index });
  const problems = useProblems(
    (p) =>
      p.on === "step" &&
      p.index === index &&
      p.field === "with" &&
      p.name === name,
  );
  return (
    <MappingField
      id={`step-with-${name}`}
      label={name}
      hint={
        <>
          JSONata over the input. The upstream&apos;s request reads it as{" "}
          <span className="font-mono">{`{{ ${name} }}`}</span>.
        </>
      }
      placeholder="input.user_id"
      initial={editor.getState().draft.nodes[index]?.with?.[name] ?? ""}
      apply={(text) =>
        edit((d) =>
          updateNode(d, index, (n) => ({
            ...n,
            with: { ...n.with, [name]: text },
          })),
        )
      }
      problems={problems}
      preview={preview}
      open={(of) => parents(of, of.nodes[index]?.id)}
      result={(p) => <Sends preview={p} />}
    />
  );
}
