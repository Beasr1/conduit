import { useShallow } from "zustand/react/shallow";

import { FieldError } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HttpStepForm } from "@/features/editor/components/http-step-form";
import { Marked } from "@/features/editor/components/problem-mark";
import { StepIdField } from "@/features/editor/components/step-id-field";
import { SaveAsUpstream } from "@/features/editor/components/save-as-upstream";
import { RunSent } from "@/features/editor/components/step-run";
import {
  AddResponse,
  StepOutput,
} from "@/features/editor/components/step-output";
import { StepUnhandled } from "@/features/editor/components/step-unhandled";
import { TransformStepForm } from "@/features/editor/components/transform-step-form";
import {
  StepParameters,
  UpstreamLine,
} from "@/features/editor/components/upstream-step";
import { asErrors, useProblems } from "@/features/editor/hooks/use-problems";
import {
  type Place,
  REQUEST_FIELDS,
  type StepField,
} from "@/features/editor/problems";
import { isLocked, useEditor } from "@/features/editor/store";

// Where each kind of step shows its problems: under its fields, or, for a
// kind the editor doesn't know, in the words that say so. A problem
// anywhere else shows above them.
const fieldsOf: Record<string, ReadonlySet<StepField | undefined>> = {
  http: new Set([
    "id",
    // A request of its own, which Publish refuses, shows by Save as
    // upstream.
    "request",
    ...REQUEST_FIELDS,
    "sample",
    "outputs",
    "unhandled",
    "unhandled_body",
    "uses",
    "with",
  ]),
  transform: new Set(["id", "expr", "unhandled", "unhandled_body"]),
};
const unknownKind = new Set<StepField | undefined>(["id", "kind"]);

// StepSettings edits one step: its id, then what its kind has. An HTTP step
// has a tab per block it's drawn as: Request, the call and its body; 2xx and
// each response it lists, with its sample and what follows it; one to add
// a response; then Unhandled, what takes its failures. The tab open is the
// editor's part, so a click on a block opens its tab. Its fields are keyed
// by the step's place in the draft rather than its id, so renaming the step
// doesn't remount them under the cursor.
export function StepSettings({ index }: { index: number }) {
  const kind: string = useEditor((s) => s.draft.nodes[index]?.kind ?? "");
  const part = useEditor((s) => s.part);
  const setPart = useEditor((s) => s.setPart);
  const statuses = useEditor(
    useShallow((s) =>
      (s.draft.nodes[index]?.outputs ?? []).map((o) => o.status),
    ),
  );
  // A step that uses an upstream (plan 07) has its request and responses
  // from it: locked, unless the upstream is being edited in place.
  const uses = useEditor((s) => s.draft.nodes[index]?.uses !== undefined);
  const locked = useEditor((s) => isLocked(s, index));
  // The forms keep what's typed, so a step moved to another version, or an
  // upstream opened or put away, draws them afresh from the draft.
  const formKey = useEditor((s) => {
    const n = s.draft.nodes[index];
    return n?.uses
      ? `${n.uses.upstream}@${n.uses.version}:${s.upstreamEdit?.node === n.id}`
      : "own";
  });
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
      {kind === "http" && uses && <UpstreamLine index={index} />}
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
            aria-label="Blocks"
            activateOnFocus
            className="flex-wrap group-data-horizontal/tabs:h-auto [&>[data-slot=tabs-trigger]]:h-auto"
          >
            {uses && (
              <TabsTrigger value="with">
                Parameters
                <Marked
                  where={(p) =>
                    mine(p) && (p.field === "with" || p.field === "uses")
                  }
                />
              </TabsTrigger>
            )}
            <TabsTrigger value="request">
              Request
              <Marked
                where={(p) =>
                  mine(p) &&
                  (REQUEST_FIELDS.has(p.field) || p.field === "request")
                }
              />
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
            {!locked && (
              <TabsTrigger value="add" aria-label="Add a response">
                + Response
              </TabsTrigger>
            )}
            <TabsTrigger value="unhandled">
              Unhandled
              <Marked
                where={(p) =>
                  mine(p) &&
                  (p.field === "unhandled" || p.field === "unhandled_body")
                }
              />
            </TabsTrigger>
          </TabsList>
          {/* Each stays mounted while hidden, so what's typed survives a
              switch. */}
          {uses && (
            <TabsContent value="with" keepMounted>
              <StepParameters key={formKey} index={index} />
            </TabsContent>
          )}
          <TabsContent value="request" keepMounted>
            <RunSent index={index} />
            <HttpStepForm key={formKey} index={index} locked={locked} />
            {!uses && <SaveAsUpstream index={index} />}
          </TabsContent>
          <TabsContent value="2xx" keepMounted>
            <StepOutput key={formKey} index={index} locked={locked} />
          </TabsContent>
          {statuses.map((status) => (
            <TabsContent key={status} value={String(status)} keepMounted>
              <StepOutput
                key={formKey}
                index={index}
                status={status}
                locked={locked}
              />
            </TabsContent>
          ))}
          {!locked && (
            <TabsContent value="add" keepMounted>
              <AddResponse index={index} taken={statuses} />
            </TabsContent>
          )}
          <TabsContent value="unhandled" keepMounted>
            <StepUnhandled index={index} />
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
