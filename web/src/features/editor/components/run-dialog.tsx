import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { readJSON, showJSON } from "@/features/editor/fields";
import { useStartRun } from "@/features/editor/hooks/use-runs";
import { useEditor, useEditorStore } from "@/features/editor/store";
import { ApiError } from "@/lib/api";

// RunButton runs the workflow: it asks for the run's input, starting from
// the sample input, saves unsaved changes first, since a run is of a saved
// revision, then starts the run and shows it on the canvas. revision is the
// revision to run once anything unsaved is saved, or undefined when the
// save failed, which the header says.
export function RunButton({
  workflow,
  disabled,
  revision,
}: {
  workflow: string;
  disabled: boolean;
  revision: () => Promise<number | undefined>;
}) {
  const editor = useEditorStore();
  const showRun = useEditor((s) => s.showRun);
  const start = useStartRun(workflow);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const input = readJSON(text);
  // A 400 says where the input doesn't match the input schema.
  const refused = start.error instanceof ApiError ? start.error : undefined;
  const said =
    input.error !== undefined
      ? [{ message: input.error }]
      : refused?.problem?.errors?.length
        ? refused.problem.errors.map((e) => ({
            message: `${e.pointer || "The input"}: ${e.detail}`,
          }))
        : refused
          ? [{ message: refused.message }]
          : [];

  async function run() {
    if (input.error !== undefined) return;
    const on = await revision();
    if (on === undefined) {
      setOpen(false);
      return;
    }
    try {
      const started = await start.mutateAsync({
        revision: on,
        input: input.value,
      });
      showRun(started.id);
      setOpen(false);
    } catch {
      // start.error says why, under the input.
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        setText(showJSON(editor.getState().draft.sample_input));
        start.reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" disabled={disabled} />}>
        Run
      </DialogTrigger>
      {/* nokey: Delete or Backspace on its buttons would otherwise reach
          the canvas and delete what's selected behind the dialog. */}
      <DialogContent className="nokey">
        <DialogHeader>
          <DialogTitle>Run</DialogTitle>
          <DialogDescription>
            Runs the workflow as it&apos;s saved, saving your changes first. Its
            steps call their APIs for real.
          </DialogDescription>
        </DialogHeader>
        <Field data-invalid={said.length > 0}>
          <FieldLabel htmlFor="run-input">Input</FieldLabel>
          <Textarea
            id="run-input"
            className="min-h-32 font-mono"
            spellCheck={false}
            aria-invalid={said.length > 0}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <FieldError errors={said} />
          <FieldDescription>
            JSON, as a caller sends it. It starts as the sample input; empty
            sends none.
          </FieldDescription>
        </Field>
        <DialogFooter>
          <Button
            disabled={start.isPending || input.error !== undefined}
            onClick={() => void run()}
          >
            {start.isPending ? "Starting…" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
