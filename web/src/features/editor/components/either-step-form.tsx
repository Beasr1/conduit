import { useShallow } from "zustand/react/shallow";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  JsonBlock,
  MappingField,
} from "@/features/editor/components/mapping-field";
import { Marked } from "@/features/editor/components/problem-mark";
import { StepConnections } from "@/features/editor/components/step-connections";
import { RunGave } from "@/features/editor/components/step-run";
import { StepUnhandled } from "@/features/editor/components/step-unhandled";
import { WholeRunNote } from "@/features/editor/components/whole-run-note";
import {
  connect,
  joinedTo,
  newWays,
  setWayBody,
} from "@/features/editor/edits";
import {
  lineFrom,
  outputOf,
  UNHANDLED_HANDLE,
  wayFromHandle,
  wayHandle,
  wayLabel,
  waysInto,
} from "@/features/editor/flow";
import { useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Preview = components["schemas"]["Preview"];

// EitherStepForm edits an Either step: a tab per way it can come by, each
// with the value it gives when that way comes; one to add a way; then its
// Unhandled. Below them, what follows it. The tab open is the editor's part,
// so a click on a way's block opens its tab, and picking the step opens its
// first way.
export function EitherStepForm({ index }: { index: number }) {
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const part = useEditor((s) => s.part);
  const setPart = useEditor((s) => s.setPart);
  const handles = useEditor(
    useShallow((s) => waysInto(s.draft, id).map((w) => w.handle)),
  );
  const labels = useEditor(
    useShallow((s) =>
      waysInto(s.draft, id).map((w) => wayLabel(s.draft, w.from, w.on)),
    ),
  );
  const edges = useEditor(
    useShallow((s) => waysInto(s.draft, id).map((w) => w.index)),
  );
  const open =
    handles.includes(part) || part === "add" || part === UNHANDLED_HANDLE
      ? part
      : (handles[0] ?? "add");
  return (
    <>
      <RunGave index={index} />
      <Tabs value={open} onValueChange={(value: string) => setPart(value)}>
        {/* The list grows as its tabs wrap, as an HTTP step's does. */}
        <TabsList
          activateOnFocus
          className="flex-wrap group-data-horizontal/tabs:h-auto [&>[data-slot=tabs-trigger]]:h-auto"
        >
          {handles.map((h, k) => (
            <TabsTrigger key={h} value={h}>
              {labels[k]}
              <Marked
                where={(p) => p.on === "connection" && p.index === edges[k]}
              />
            </TabsTrigger>
          ))}
          <TabsTrigger value="add" aria-label="Add a way">
            + Way
          </TabsTrigger>
          <TabsTrigger value={UNHANDLED_HANDLE}>
            Unhandled
            <Marked
              where={(p) =>
                p.on === "step" &&
                p.index === index &&
                p.field === "unhandled_body"
              }
            />
          </TabsTrigger>
        </TabsList>
        {/* Each stays mounted while hidden, so what's typed survives a
            switch. */}
        {handles.map((h, k) => (
          <TabsContent key={h} value={h} keepMounted>
            <WayForm index={index} edge={edges[k] ?? -1} />
          </TabsContent>
        ))}
        <TabsContent value="add" keepMounted>
          <AddWay index={index} />
        </TabsContent>
        <TabsContent value={UNHANDLED_HANDLE} keepMounted>
          <StepUnhandled index={index} />
        </TabsContent>
      </Tabs>
      <StepConnections index={index} />
    </>
  );
}

// WayForm edits one way into an Either step: the value the step gives when
// it's the way that comes, JSONata over what the way's connection reads,
// simulated over the samples. With none, it gives the body of the way's
// step as it is. Its value goes to callers once the step answers, so only
// then is sending the run warned about.
function WayForm({ index, edge }: { index: number; edge: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const from = useEditor((s) => s.draft.edges?.[edge]?.from ?? "");
  const label = useEditor((s) => {
    const e = s.draft.edges?.[edge];
    return e ? wayLabel(s.draft, e.from, outputOf(e)) : "";
  });
  const body = useEditor((s) => s.draft.edges?.[edge]?.body);
  const answers = useEditor(
    (s) => id !== "" && joinedTo(s.draft, id).length > 0,
  );
  const preview = usePreview({ edge });
  const problems = useProblems(
    (p) => p.on === "connection" && p.index === edge && p.field === "body",
  );
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        When it comes by <span className="font-mono">{label}</span>, the step
        gives this value. The steps after read it as{" "}
        <span className="font-mono">{`nodes.${id}.body`}</span>, whichever way
        came.
      </p>
      <MappingField
        id={`way-${edge}-value`}
        label="Value"
        description={
          <>
            JSONata over what {from} and the steps before it got back. Empty
            gives {from}&apos;s body as it is.
          </>
        }
        placeholder={`nodes.${from}.body`}
        initial={editor.getState().draft.edges?.[edge]?.body ?? ""}
        apply={(text) =>
          edit((d) =>
            setWayBody(d, edge, text.trim() === "" ? undefined : text),
          )
        }
        problems={problems}
        preview={preview}
        open={(of) => [of.edges?.[edge]?.from ?? ""]}
        result={(p) => <WayGives preview={p} from={from} />}
      />
      {answers && <WholeRunNote text={body} />}
    </div>
  );
}

// WayGives is what an Either gives, over the samples, when this way comes,
// and whether a run would take the way.
function WayGives({ preview, from }: { preview: Preview; from: string }) {
  if (preview.skipped)
    return (
      <p>
        With these samples, a run would skip {from}, so this way wouldn&apos;t
        come.
      </p>
    );
  return (
    <>
      <h3 className="font-medium">It gives</h3>
      {preview.gives === undefined ? (
        <p className="text-muted-foreground">Nothing.</p>
      ) : (
        <JsonBlock value={preview.gives} />
      )}
      {preview.taken === false && (
        <p className="text-muted-foreground">
          With these samples, this way wouldn&apos;t come: its connection
          isn&apos;t taken.
        </p>
      )}
    </>
  );
}

// AddWay joins one of a step's responses to an Either as a way, as drawing
// a line from the step's point to the Either's + Add does, so it can be done
// from the keyboard too (WCAG 2.5.7). The new way's tab opens.
function AddWay({ index }: { index: number }) {
  const edit = useEditor((s) => s.edit);
  const setPart = useEditor((s) => s.setPart);
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const offered = useEditor(
    useShallow((s) =>
      newWays(s.draft, id).map((w) =>
        wayHandle({ from: w.from, ...lineFrom(w.on) }),
      ),
    ),
  );
  const labels = useEditor(
    useShallow((s) =>
      newWays(s.draft, id).map((w) => wayLabel(s.draft, w.from, w.on)),
    ),
  );
  return (
    <section className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        It runs after whichever of its ways comes. To add one, draw a line from
        a step&apos;s point to + Add on this step, or pick it here.
      </p>
      <Field>
        <FieldLabel htmlFor={`either-add-way-${index}`}>
          Add a way from
        </FieldLabel>
        <Select<string>
          value={null}
          disabled={offered.length === 0}
          onValueChange={(handle) => {
            if (handle === null) return;
            const w = wayFromHandle(handle);
            edit((d) => connect(d, w.from, id, w.on));
            setPart(handle);
          }}
        >
          <SelectTrigger id={`either-add-way-${index}`} className="w-full">
            <SelectValue
              placeholder={
                offered.length === 0
                  ? "No step to add a way from"
                  : "Pick a step's response"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {offered.map((h, k) => (
              <SelectItem key={h} value={h}>
                {labels[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          Two ways one run could both take are a problem when saved, unless a
          condition before them decides; then a run in which both come fails the
          step.
        </FieldDescription>
      </Field>
    </section>
  );
}
