import { useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { Button, buttonVariants } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import {
  JsonBlock,
  MappingField,
  Skipped,
} from "@/features/editor/components/mapping-field";
import { Sends } from "@/features/editor/components/step-body";
import { parents, updateNode } from "@/features/editor/edits";
import { asErrors, useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { ofUsed, type Place } from "@/features/editor/problems";
import { useEditor, useEditorStore } from "@/features/editor/store";
import {
  inputOf,
  pin,
  pinCalled,
  versionKey,
} from "@/features/editor/upstreams";
import {
  fetchCalled,
  fetchVersion,
  useUpstream,
  useUsedWorkflow,
} from "@/features/editor/hooks/use-upstreams";
import type { components } from "@/gen/schema";
import { routes } from "@/router";

type Preview = components["schemas"]["Preview"];

// onLine is a problem a step's line shows: in what the step uses.
const onLine = (index: number) => (p: Place) =>
  p.on === "step" && p.index === index && ofUsed(p.field);

// UpstreamLine says which upstream a step uses, at which version, with its
// call, offers a newer version, and opens the upstream, which is changed
// only on its page (plan 07). That opens in a new tab, so the draft stays as
// it is here; back on this tab, the library is asked again, and a version
// saved there is offered.
export function UpstreamLine({ index }: { index: number }) {
  const uses = useEditor((s) => s.draft.nodes[index]?.uses);
  const upstream = uses?.upstream ?? "";
  const version = uses?.version ?? 0;
  const pinned = useEditor((s) =>
    uses ? s.versions[versionKey(uses)] : undefined,
  );
  const addVersion = useEditor((s) => s.addVersion);
  const edit = useEditor((s) => s.edit);
  const client = useQueryClient();
  const library = useUpstream(upstream);
  const problems = useProblems(onLine(index));
  const [failed, setFailed] = useState<string[]>([]);
  if (!uses) return null;
  const name = library.data?.upstream.name ?? upstream;
  const latest = library.data?.version;
  const newer = latest !== undefined && latest > version;

  async function take(next: number) {
    const to = { upstream, version: next };
    try {
      const v = await fetchVersion(client, to);
      addVersion(versionKey(to), v.definition);
      edit((d) => updateNode(d, index, (n) => pin(n, to, v.definition)));
      setFailed([]);
    } catch {
      setFailed([`Couldn't get v${next}. Try again.`]);
    }
  }

  return (
    <section
      id="step-upstream"
      aria-label="Upstream"
      // The problem list takes the cursor here.
      tabIndex={-1}
      className="flex flex-col gap-2 rounded-md border p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-medium">{name}</span>{" "}
          <span className="text-muted-foreground">· v{version}</span>
        </p>
        <div className="flex gap-1">
          {newer && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void take(latest)}
            >
              Use v{latest}
            </Button>
          )}
          <Link
            to={routes.upstream(upstream)}
            target="_blank"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open upstream
            <ExternalLinkIcon aria-hidden />
            <span className="sr-only">, opens in a new tab</span>
          </Link>
        </div>
      </div>
      {pinned && (
        <p className="font-mono text-xs break-all text-muted-foreground">
          {pinned.request.method} {pinned.request.url}
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
// the one it serves when that's newer, and opens it, in a new tab as an
// upstream opens (plan 07). A workflow is changed on its own page.
export function WorkflowLine({ index }: { index: number }) {
  const uses = useEditor((s) => s.draft.nodes[index]?.uses);
  const addCalled = useEditor((s) => s.addCalled);
  const edit = useEditor((s) => s.edit);
  const client = useQueryClient();
  const workflow = uses?.workflow ?? "";
  const revision = uses?.revision ?? 0;
  const used = useUsedWorkflow(workflow);
  const problems = useProblems(onLine(index));
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
      // The problem list takes the cursor here.
      tabIndex={-1}
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
            target="_blank"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open workflow
            <ExternalLinkIcon aria-hidden />
            <span className="sr-only">, opens in a new tab</span>
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
// JSONata over the run, previewed as the request it makes.
export function StepParameters({ index }: { index: number }) {
  const pinned = useEditor((s) => {
    const uses = s.draft.nodes[index]?.uses;
    return uses ? s.versions[versionKey(uses)] : undefined;
  });
  const names = (pinned?.parameters ?? []).map((p) => p.name);

  return (
    <div className="flex flex-col gap-5">
      {names.length === 0 && (
        <p className="text-sm text-muted-foreground">
          The upstream takes no parameters.
        </p>
      )}
      {names.map((name) => (
        <ParameterField key={name} index={index} name={name} />
      ))}
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
