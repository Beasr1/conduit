import { useShallow } from "zustand/react/shallow";

import { FieldError } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HttpStepForm } from "@/features/editor/components/http-step-form";
import { MergeStepForm } from "@/features/editor/components/merge-step-form";
import { Marked } from "@/features/editor/components/problem-mark";
import { StepIdField } from "@/features/editor/components/step-id-field";
import { RunSent } from "@/features/editor/components/step-run";
import {
  AddResponse,
  StepOutput,
} from "@/features/editor/components/step-output";
import { StepUnhandled } from "@/features/editor/components/step-unhandled";
import { TransformStepForm } from "@/features/editor/components/transform-step-form";
import { asErrors, useProblems } from "@/features/editor/hooks/use-problems";
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
  http: new Set([
    "id",
    ...REQUEST_FIELDS,
    "sample",
    "outputs",
    "unhandled_body",
  ]),
  transform: new Set(["id", "expr", "unhandled_body"]),
  merge: new Set(["id", "expr", "unhandled_body"]),
};
const unknownKind = new Set<StepField | undefined>(["id", "kind"]);

// StepSettings edits one step: its id, then what its kind has. An HTTP step
// has a tab per block it's drawn as: Request, the call and its body; 2xx and
// each response it lists, with its sample and what follows it; one to add
// a response; then Unhandled, what takes its failures. The tab open is the
// editor's part, so a click on a block
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
          {/* The list grows as its tabs wrap, and each tab is as tall as
              its label: its own height, a share of the list's, would make
              every one as tall as the rows together. */}
          <TabsList
            activateOnFocus
            className="flex-wrap group-data-horizontal/tabs:h-auto [&>[data-slot=tabs-trigger]]:h-auto"
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
            <TabsTrigger value="unhandled">
              Unhandled
              <Marked where={(p) => mine(p) && p.field === "unhandled_body"} />
            </TabsTrigger>
          </TabsList>
          {/* Each stays mounted while hidden, so what's typed survives a
              switch. */}
          <TabsContent value="request" keepMounted>
            <RunSent index={index} />
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
          <TabsContent value="unhandled" keepMounted>
            <StepUnhandled index={index} />
          </TabsContent>
        </Tabs>
      )}
      {kind === "transform" && (
        <TransformStepForm key={`transform-${index}`} index={index} />
      )}
      {kind === "merge" && (
        <MergeStepForm key={`merge-${index}`} index={index} />
      )}
      {kind !== "http" && kind !== "transform" && kind !== "merge" && (
        <p className="text-sm text-muted-foreground">
          The editor doesn&apos;t know steps of the kind “{kind}”. Delete this
          one, or change its kind through the API.
        </p>
      )}
    </>
  );
}
