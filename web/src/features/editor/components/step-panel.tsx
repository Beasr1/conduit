import { useShallow } from "zustand/react/shallow";

import { FieldError } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HttpStepForm } from "@/features/editor/components/http-step-form";
import { ProblemMark } from "@/features/editor/components/problem-mark";
import { StepIdField } from "@/features/editor/components/step-id-field";
import {
  AddResponse,
  StepOutput,
} from "@/features/editor/components/step-output";
import { TransformStepForm } from "@/features/editor/components/transform-step-form";
import {
  asErrors,
  useProblemCount,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import {
  type Place,
  REQUEST_FIELDS,
  type StepField,
} from "@/features/editor/problems";
import { useEditor } from "@/features/editor/store";

// Where each kind of step shows its problems: under its fields, or, for a
// kind the editor doesn't know, in the words that say so. A problem
// anywhere else shows above them.
const fieldsOf: Record<string, ReadonlySet<StepField | undefined>> = {
  http: new Set(["id", ...REQUEST_FIELDS, "sample", "outputs"]),
  transform: new Set(["id", "expr"]),
};
const unknownKind = new Set<StepField | undefined>(["id", "kind"]);

// StepSettings edits one step: its id, then what its kind has. An HTTP step
// has a tab per block it's drawn as: Request, the call and its body; 2xx and
// each response it lists, with its sample and what follows it; then one to
// add a response. The tab open is the editor's part, so a click on a block
// opens its tab. Its fields are keyed by the step's place in the draft
// rather than its id, so renaming the step doesn't remount them under the
// cursor.
export function StepSettings({ index }: { index: number }) {
  const kind: string = useEditor((s) => s.draft.nodes[index]?.kind ?? "");
  const part = useEditor((s) => s.part);
  const setPart = useEditor((s) => s.setPart);
  const statuses = useEditor(
    useShallow((s) =>
      (s.draft.nodes[index]?.outputs ?? []).map((o) => o.status),
    ),
  );
  const shown = fieldsOf[kind] ?? unknownKind;
  const elsewhere = useProblems(
    (p) => p.on === "step" && p.index === index && !shown.has(p.field),
  );
  const mine = (p: Place): p is Extract<Place, { on: "step" }> =>
    p.on === "step" && p.index === index;
  return (
    <>
      <FieldError errors={asErrors(elsewhere)} />
      <StepIdField key={`id-${index}`} index={index} />
      {kind === "http" && (
        <Tabs
          key={`http-${index}`}
          value={part}
          onValueChange={(value: string) => setPart(value)}
        >
          <TabsList
            activateOnFocus
            className="flex-wrap group-data-horizontal/tabs:h-auto"
          >
            <TabsTrigger value="request">
              Request
              <Marked where={(p) => mine(p) && REQUEST_FIELDS.has(p.field)} />
            </TabsTrigger>
            <TabsTrigger value="2xx">
              2xx
              <Marked
                where={(p) =>
                  mine(p) && p.field === "sample" && p.output === undefined
                }
              />
            </TabsTrigger>
            {statuses.map((status, j) => (
              <TabsTrigger key={status} value={String(status)}>
                {status}
                <Marked where={(p) => mine(p) && p.output === j} />
              </TabsTrigger>
            ))}
            <TabsTrigger value="add" aria-label="Add a response">
              + Response
            </TabsTrigger>
          </TabsList>
          {/* Each stays mounted while hidden, so what's typed survives a
              switch. */}
          <TabsContent value="request" keepMounted>
            <HttpStepForm index={index} />
          </TabsContent>
          <TabsContent value="2xx" keepMounted>
            <StepOutput index={index} />
          </TabsContent>
          {statuses.map((status) => (
            <TabsContent key={status} value={String(status)} keepMounted>
              <StepOutput index={index} status={status} />
            </TabsContent>
          ))}
          <TabsContent value="add" keepMounted>
            <AddResponse index={index} taken={statuses} />
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

// Marked marks a tab whose part of the step has problems.
function Marked({ where }: { where: (p: Place) => boolean }) {
  const count = useProblemCount(where);
  return count > 0 ? <ProblemMark count={count} /> : null;
}
