import { useState } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StepConnections } from "@/features/editor/components/step-connections";
import { RunGot } from "@/features/editor/components/step-run";
import {
  StepSample,
  UpstreamSample,
} from "@/features/editor/components/step-sample";
import { addOutput } from "@/features/editor/edits";
import { whole } from "@/features/editor/fields";
import { useEditor } from "@/features/editor/store";

// The statuses a response besides 2xx can have, as schema/workflow.yaml
// allows.
const MIN_OUTPUT = 300;
const MAX_OUTPUT = 599;

// StepOutput is one of an http step's responses, its 2xx or, given a
// status, one it lists, as its tab shows it: its sample, under the status
// that's its condition, and the connections that leave on it.
export function StepOutput({
  index,
  status,
  locked = false,
  calls = false,
}: {
  index: number;
  status?: number;
  // Its sample is an upstream's, read here and changed on its page
  // (plan 07); what follows it stays the workflow's.
  locked?: boolean;
  // It uses a workflow, whose own preview stands in for a sample.
  calls?: boolean;
}) {
  const [kept, setKept] = useState(0);
  return (
    <div className="flex flex-col gap-5">
      <RunGot
        index={index}
        status={status}
        locked={locked}
        calls={calls}
        kept={() => setKept((n) => n + 1)}
      />
      {calls ? (
        <p className="text-sm text-muted-foreground">
          Previews take it from the workflow&apos;s own preview, over the input
          this step gives it.
        </p>
      ) : locked ? (
        <UpstreamSample index={index} status={status} />
      ) : (
        // Keyed by the times a run's answer was kept, so its fields show
        // the sample they were given rather than what was typed before.
        <StepSample key={kept} index={index} status={status} />
      )}
      <StepConnections index={index} on={status} />
    </div>
  );
}

// AddResponse adds a response besides 2xx, by its status, with no sample
// yet, and opens its tab.
export function AddResponse({
  index,
  taken,
}: {
  index: number;
  taken: number[];
}) {
  const edit = useEditor((s) => s.edit);
  const setPart = useEditor((s) => s.setPart);
  const [text, setText] = useState("");
  const status = whole(text, MIN_OUTPUT, MAX_OUTPUT);
  const error =
    status === null
      ? `A whole number from ${MIN_OUTPUT} to ${MAX_OUTPUT}: 2xx is always there.`
      : status !== undefined && taken.includes(status)
        ? "It has a response for that status already."
        : undefined;

  function add() {
    if (status === null || status === undefined || error !== undefined) return;
    edit((d) => addOutput(d, index, status));
    setPart(String(status));
    setText("");
  }

  return (
    <Field data-invalid={error !== undefined}>
      <div className="flex items-center gap-1">
        <FieldLabel htmlFor="step-output-status">Add a response</FieldLabel>
        <Hint about="Add a response">
          A status the run goes on from rather than failing. A status with no
          response goes to Unhandled.
        </Hint>
      </div>
      <div className="flex gap-2">
        <Input
          id="step-output-status"
          inputMode="numeric"
          placeholder="404"
          aria-invalid={error !== undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={
            status === null || status === undefined || error !== undefined
          }
          onClick={add}
        >
          Add
        </Button>
      </div>
      <FieldError errors={error === undefined ? [] : [{ message: error }]} />
    </Field>
  );
}
