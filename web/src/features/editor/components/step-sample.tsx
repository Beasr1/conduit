import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { removeOutput, updateNode } from "@/features/editor/edits";
import {
  readHeaders,
  readJSON,
  showJSON,
  whole,
} from "@/features/editor/fields";
import {
  asErrors,
  atStep,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Node = components["schemas"]["Node"];
type Sample = components["schemas"]["Sample"];

// The statuses a 2xx sample can have, as schema/workflow.yaml allows.
const MIN_STATUS = 200;
const MAX_STATUS = 299;

// StepSample is one of an http step's responses, with its sample: its 2xx,
// or, given a status, the response it lists for that status, which can be
// removed. A sample is made-up or redacted JSON that previews read in place
// of a real response. Each part counts once it's whole, and until then the
// stored one stays, as in the request's fields. With no body, there's no
// sample. A listed response's sample takes its status, so it has no status
// of its own. Its fields are named for it, as every response's tab stays
// mounted.
export function StepSample({
  index,
  status,
}: {
  index: number;
  status?: number;
}) {
  const title = status === undefined ? "2xx" : String(status);
  const at = status === undefined ? "step-sample" : `step-sample-${status}`;
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const [text, setText] = useState(() => {
    const s = sampleOf(editor.getState().draft.nodes[index], status);
    return {
      status: s?.status === undefined ? "" : String(s.status),
      headers: showJSON(s?.headers),
      body: s === undefined ? "" : showJSON(s.body),
    };
  });
  const st = whole(text.status, MIN_STATUS, MAX_STATUS);
  const headers = readHeaders(text.headers);
  const body = readJSON(text.body);
  // Its problems: the 2xx sample's, or those at its place in the outputs.
  const output = useEditor((s) =>
    status === undefined
      ? undefined
      : (s.draft.nodes[index]?.outputs ?? []).findIndex(
          (o) => o.status === status,
        ),
  );
  const found = useProblems(
    (p) =>
      atStep(index, "sample", "outputs")(p) &&
      p.on === "step" &&
      p.output === output,
  );
  const said = {
    status:
      st === null
        ? [{ message: `A whole number from ${MIN_STATUS} to ${MAX_STATUS}.` }]
        : [],
    headers: headers.error === undefined ? [] : [{ message: headers.error }],
    body: body.error === undefined ? [] : [{ message: body.error }],
  };

  function change(part: keyof typeof text, value: string) {
    const next = { ...text, [part]: value };
    setText(next);
    const s = whole(next.status, MIN_STATUS, MAX_STATUS);
    const h = readHeaders(next.headers);
    const b = readJSON(next.body);
    const sample = (was: Sample | undefined): Sample | undefined => {
      const kept = b.error === undefined ? b.value : was?.body;
      if (kept === undefined) return undefined;
      const sc =
        status !== undefined ? undefined : s === null ? was?.status : s;
      const hd = h.error === undefined ? h.value : was?.headers;
      return {
        ...(sc === undefined ? {} : { status: sc }),
        ...(hd === undefined ? {} : { headers: hd }),
        body: kept,
      };
    };
    edit((d) =>
      updateNode(d, index, (n) =>
        withSample(n, status, sample(sampleOf(n, status))),
      ),
    );
  }

  return (
    <FieldSet className="gap-3">
      <div className="flex items-center justify-between gap-2">
        <FieldLegend variant="label">{title} response</FieldLegend>
        {status !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Remove the ${title} response`}
            onClick={() => edit((d) => removeOutput(d, index, status))}
          >
            Remove
          </Button>
        )}
      </div>
      <FieldDescription>
        A sample of what the API answers{" "}
        {status === undefined ? "when it succeeds" : `with ${status}`}: previews
        read it in place of a real response, and runs ignore it. It&apos;s saved
        in every revision, so make it up or redact it.
        {status !== undefined &&
          " Removing the response removes the connections that leave on it."}
      </FieldDescription>
      <FieldError errors={asErrors(found)} />
      <Field data-invalid={said.body.length > 0}>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={`${at}-body`}>Body</FieldLabel>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Format ${title} body`}
            disabled={body.value === undefined}
            onClick={() => change("body", showJSON(body.value))}
          >
            Format
          </Button>
        </div>
        <Textarea
          id={`${at}-body`}
          aria-label={`${title} body`}
          className="min-h-32 font-mono"
          spellCheck={false}
          placeholder={
            status === undefined
              ? '{ "id": "7", "email": "ada@example.com" }'
              : '{ "error": "not found" }'
          }
          aria-invalid={said.body.length > 0}
          value={text.body}
          onChange={(e) => change("body", e.target.value)}
        />
        <FieldError errors={said.body} />
        <FieldDescription>
          JSON. Empty means no sample, and null an empty body.
        </FieldDescription>
      </Field>
      {status === undefined && (
        <Field data-invalid={said.status.length > 0}>
          <FieldLabel htmlFor={`${at}-status`}>Status</FieldLabel>
          <Input
            id={`${at}-status`}
            aria-label={`${title} status`}
            inputMode="numeric"
            placeholder="200"
            aria-invalid={said.status.length > 0}
            value={text.status}
            onChange={(e) => change("status", e.target.value)}
          />
          <FieldError errors={said.status} />
        </Field>
      )}
      <Field data-invalid={said.headers.length > 0}>
        <FieldLabel htmlFor={`${at}-headers`}>Headers</FieldLabel>
        <Textarea
          id={`${at}-headers`}
          aria-label={`${title} headers`}
          className="min-h-16 font-mono"
          spellCheck={false}
          placeholder='{ "content-type": "application/json" }'
          aria-invalid={said.headers.length > 0}
          value={text.headers}
          onChange={(e) => change("headers", e.target.value)}
        />
        <FieldError errors={said.headers} />
      </Field>
    </FieldSet>
  );
}

// sampleOf is a step's sample for one of its responses: its 2xx, or the one
// it lists for status.
function sampleOf(n: Node | undefined, status?: number): Sample | undefined {
  return status === undefined
    ? n?.sample
    : n?.outputs?.find((o) => o.status === status)?.sample;
}

// withSample gives one of a step's responses its sample, or none.
export function withSample(
  n: Node,
  status: number | undefined,
  sample: Sample | undefined,
): Node {
  if (status === undefined) return { ...n, sample };
  return {
    ...n,
    outputs: (n.outputs ?? []).map((o) =>
      o.status !== status ? o : { status, ...(sample ? { sample } : {}) },
    ),
  };
}
