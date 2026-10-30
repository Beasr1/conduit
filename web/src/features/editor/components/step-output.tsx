import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StepConnections } from "@/features/editor/components/step-connections";
import { StepResponse } from "@/features/editor/components/step-response";
import { RunGot } from "@/features/editor/components/step-run";
import { StepSample } from "@/features/editor/components/step-sample";
import { addOutput } from "@/features/editor/edits";
import { whole } from "@/features/editor/fields";
import { useEditor } from "@/features/editor/store";

// The statuses a response besides 2xx can have, as schema/workflow.yaml
// allows.
const MIN_OUTPUT = 300;
const MAX_OUTPUT = 599;

// StepOutput is one of an http step's responses, its 2xx or, given a
// status, one it lists, as its tab shows it: its sample, the connections
// that leave on it, and how the steps after read it.
export function StepOutput({
  index,
  status,
}: {
  index: number;
  status?: number;
}) {
  const [kept, setKept] = useState(0);
  return (
    <div className="flex flex-col gap-5">
      <RunGot
        index={index}
        status={status}
        kept={() => setKept((n) => n + 1)}
      />
      {/* Keyed by the times a run's answer was kept, so its fields show
          the sample they were given rather than what was typed before. */}
      <StepSample key={kept} index={index} status={status} />
      <StepConnections index={index} on={status} />
      <StepResponse index={index} />
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
      <FieldLabel htmlFor="step-output-status">Add a response</FieldLabel>
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
      <FieldDescription>
        By its status, as 404, when a run should go on rather than fail. Every
        HTTP step has 2xx; any status it has no response for fails the step, and
        the run. Each response is a block on the step, which connections leave
        from.
      </FieldDescription>
    </Field>
  );
}
