import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { MappingField } from "@/features/editor/components/mapping-field";
import { updateEdge } from "@/features/editor/edits";
import { asErrors, useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type Preview = components["schemas"]["Preview"];

// Join is how a connection joins the step it goes into: one the step needs,
// as it needs every line into an HTTP step, and a transform's lone line;
// one of a transform's lines marked required; or one of its ways, which may
// not come, beside lines marked required ("optional") or not ("way").
type Join = "needed" | "required" | "optional" | "way";

function joinOf(d: Definition, index: number): Join {
  const edge = d.edges?.[index];
  const lines = (d.edges ?? []).filter((e) => e.to === edge?.to);
  if (
    d.nodes.find((n) => n.id === edge?.to)?.kind !== "transform" ||
    lines.length < 2
  )
    return "needed";
  if (edge?.required) return "required";
  return lines.some((e) => e.required) ? "optional" : "way";
}

// ConnectionForm edits a connection's condition between the data it reads
// and whether a run takes the connection, simulated over the samples: what
// its step and the steps before it got back, its step answering with the
// response the connection leaves from; the condition, which goes into the
// draft as it's typed; then whether it's taken. No text means it's taken
// whenever its step answers that way. One into a transform can be marked
// required, as a parameter the transform can't do without.
export function ConnectionForm({ index }: { index: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const edge = useEditor((s) => s.draft.edges?.[index]);
  const http = useEditor(
    (s) =>
      s.draft.nodes.find((n) => n.id === s.draft.edges?.[index]?.from)?.kind ===
      "http",
  );
  const transform = useEditor(
    (s) =>
      s.draft.nodes.find((n) => n.id === s.draft.edges?.[index]?.to)?.kind ===
      "transform",
  );
  const join = useEditor((s) => joinOf(s.draft, index));
  const preview = usePreview({ edge: index });
  const found = useProblems((p) => p.on === "connection" && p.index === index);
  const when = found.filter(
    (f) => f.place.on === "connection" && f.place.field === "when",
  );
  const required = found.filter(
    (f) => f.place.on === "connection" && f.place.field === "required",
  );
  if (!edge) return null;

  return (
    <>
      <p className="text-sm">
        From <span className="font-mono">{edge.from}</span>
        {http && (
          <>
            , on <span className="font-mono">{edge.on ?? "2xx"}</span>,
          </>
        )}{" "}
        to <span className="font-mono">{edge.to}</span>.
      </p>
      <FieldError
        errors={asErrors(
          found.filter((f) => !when.includes(f) && !required.includes(f)),
        )}
      />
      {/* An HTTP step's line shows it too when it's marked, so the mark can
          come off. */}
      {(transform || edge.required) && (
        <Field orientation="horizontal" data-invalid={required.length > 0}>
          <Checkbox
            id="connection-required"
            checked={edge.required === true}
            aria-invalid={required.length > 0}
            onCheckedChange={(on) =>
              edit((d) =>
                updateEdge(d, index, (e) => ({
                  ...e,
                  required: on ? true : undefined,
                })),
              )
            }
          />
          <FieldContent>
            <FieldLabel htmlFor="connection-required">Required</FieldLabel>
            <FieldDescription>
              A promise that {edge.from} is there whenever {edge.to} runs, so
              its expression can read it without checking: {edge.to} runs only
              once this line came. Unmarked, {edge.to} may run without it, once
              another line came. Saving says where a promise shuts a line out.
            </FieldDescription>
            <FieldError errors={asErrors(required)} />
          </FieldContent>
        </Field>
      )}
      <MappingField
        id="connection-when"
        label="Condition"
        description={
          <>
            JSONata over what {edge.from} and the steps before it got back.{" "}
            {join === "way"
              ? `${edge.to}, a transform, runs if any of its ways is taken, once all have ended, and this way is taken only when this is true`
              : join === "optional"
                ? `${edge.to}, a transform, runs once its required lines are taken, with this way or without it, and this way is taken only when this is true`
                : join === "required"
                  ? `${edge.to} runs only when this is true and its other required lines are taken`
                  : `${edge.to} runs only when this is true and its other connections are taken`}
            ; empty means always. A step that doesn't run is skipped, and so are
            the steps after it that need it.
          </>
        }
        placeholder={`nodes.${edge.from}.body.active = true`}
        initial={editor.getState().draft.edges?.[index]?.when ?? ""}
        apply={(text) =>
          edit((d) =>
            updateEdge(d, index, (e) => ({
              ...e,
              when: text.trim() === "" ? undefined : text,
            })),
          )
        }
        problems={when}
        preview={preview}
        open={(of) => [of.edges?.[index]?.from ?? ""]}
        result={(p) => (
          <Taken preview={p} from={edge.from} to={edge.to} join={join} />
        )}
      />
    </>
  );
}

// Taken says whether a run would take the connection, with these samples.
function Taken({
  preview,
  from,
  to,
  join,
}: {
  preview: Preview;
  from: string;
  to: string;
  join: Join;
}) {
  return (
    <>
      <h3 className="font-medium">With these samples</h3>
      <p>
        {preview.skipped
          ? `A run would skip ${from}, so it wouldn't take this connection.`
          : preview.taken === undefined
            ? "It can't tell yet: the problems above say why."
            : preview.taken
              ? {
                  needed: `Taken, so ${to} runs once its other connections are.`,
                  required: `Taken, so ${to} runs once its other required lines are.`,
                  optional: `Taken, so ${to} reads it, once its required lines are taken.`,
                  way: `Taken, so ${to} runs, with this way among those that came.`,
                }[join]
              : {
                  needed: `Not taken, so ${to} is skipped: it needs every connection into it.`,
                  required: `Not taken, so ${to} is skipped: this line is required.`,
                  optional: `Not taken. ${to} runs without it once its required lines are taken.`,
                  way: `Not taken. ${to} runs if another of its ways is.`,
                }[join]}
      </p>
    </>
  );
}
