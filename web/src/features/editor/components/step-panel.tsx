import { FieldError } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HttpStepForm } from "@/features/editor/components/http-step-form";
import { ProblemMark } from "@/features/editor/components/problem-mark";
import { StepIdField } from "@/features/editor/components/step-id-field";
import { StepResponse } from "@/features/editor/components/step-response";
import { TransformStepForm } from "@/features/editor/components/transform-step-form";
import {
  asErrors,
  useProblemCount,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import { REQUEST_FIELDS, type StepField } from "@/features/editor/problems";
import { useEditor } from "@/features/editor/store";

// Where each kind of step shows its problems: under its fields, or, for a
// kind the editor doesn't know, in the words that say so. A problem
// anywhere else shows above them.
const fieldsOf: Record<string, ReadonlySet<StepField | undefined>> = {
  http: new Set(["id", ...REQUEST_FIELDS]),
  transform: new Set(["id", "expr"]),
};
const unknownKind = new Set<StepField | undefined>(["id", "kind"]);

// StepSettings edits one step: its id, then what its kind has. Its fields are
// keyed by the step's place in the draft rather than its id, so renaming the
// step doesn't remount them under the cursor.
export function StepSettings({ index }: { index: number }) {
  const kind: string = useEditor((s) => s.draft.nodes[index]?.kind ?? "");
  const shown = fieldsOf[kind] ?? unknownKind;
  const elsewhere = useProblems(
    (p) => p.on === "step" && p.index === index && !shown.has(p.field),
  );
  const request = useProblemCount(
    (p) => p.on === "step" && p.index === index && REQUEST_FIELDS.has(p.field),
  );
  return (
    <>
      <FieldError errors={asErrors(elsewhere)} />
      <StepIdField key={`id-${index}`} index={index} />
      {kind === "http" && (
        <Tabs key={`http-${index}`} defaultValue="request">
          <TabsList activateOnFocus>
            <TabsTrigger value="request">
              Request
              {request > 0 && <ProblemMark count={request} />}
            </TabsTrigger>
            <TabsTrigger value="response">Response</TabsTrigger>
          </TabsList>
          {/* Mounted while hidden, so what's typed survives a switch. */}
          <TabsContent value="request" keepMounted>
            <HttpStepForm index={index} />
          </TabsContent>
          <TabsContent value="response">
            <StepResponse index={index} />
          </TabsContent>
        </Tabs>
      )}
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
