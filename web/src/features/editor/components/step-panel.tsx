import { XIcon } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { HttpStepForm } from "@/features/editor/components/http-step-form";
import { StepIdField } from "@/features/editor/components/step-id-field";
import { TransformStepForm } from "@/features/editor/components/transform-step-form";
import { toFlow } from "@/features/editor/flow";
import { useEditor } from "@/features/editor/store";

const titles: Record<string, string> = {
  http: "HTTP step",
  transform: "Transform step",
};

// StepPanel holds the settings of the one step picked on the canvas. Its
// fields are keyed by the step's place in the draft rather than its id, so
// renaming the step doesn't remount them under the cursor.
export function StepPanel() {
  const draft = useEditor((s) => s.draft);
  const selected = useEditor((s) => s.selected);
  const pick = useEditor((s) => s.pick);
  const picked =
    selected.nodes.length === 1 && selected.edges.length === 0
      ? selected.nodes[0]
      : undefined;
  const index = useMemo(
    () =>
      picked === undefined
        ? undefined
        : toFlow(draft).nodes.find((n) => n.id === picked)?.data.index,
    [draft, picked],
  );
  if (picked === undefined || index === undefined) return null;
  const kind: string = draft.nodes[index]?.kind ?? "";

  // nokey: React Flow deletes what's selected on Delete or Backspace anywhere
  // on the page except in a text field. Without it, either key on one of
  // these buttons deleted the step being edited.
  return (
    <aside
      aria-labelledby="step-title"
      className="nokey flex w-96 shrink-0 flex-col gap-5 overflow-y-auto rounded-lg border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="step-title" className="font-heading text-base font-semibold">
          {titles[kind] ?? "Step"}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={() => pick("nodes", [{ id: picked, selected: false }])}
        >
          <XIcon />
        </Button>
      </div>
      <StepIdField key={`id-${index}`} index={index} />
      {kind === "http" && <HttpStepForm key={`http-${index}`} index={index} />}
      {kind === "transform" && (
        <TransformStepForm key={`transform-${index}`} index={index} />
      )}
      {kind !== "http" && kind !== "transform" && (
        <p className="text-sm text-muted-foreground">
          The editor doesn&apos;t know steps of the kind “{kind}”. Delete this
          one, or change its kind through the API.
        </p>
      )}
    </aside>
  );
}
