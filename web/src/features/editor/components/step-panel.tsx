import { HttpStepForm } from "@/features/editor/components/http-step-form";
import { StepIdField } from "@/features/editor/components/step-id-field";
import { TransformStepForm } from "@/features/editor/components/transform-step-form";
import { useEditor } from "@/features/editor/store";

// StepSettings edits one step: its id, then what its kind has. Its fields are
// keyed by the step's place in the draft rather than its id, so renaming the
// step doesn't remount them under the cursor.
export function StepSettings({ index }: { index: number }) {
  const kind: string = useEditor((s) => s.draft.nodes[index]?.kind ?? "");
  return (
    <>
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
    </>
  );
}
