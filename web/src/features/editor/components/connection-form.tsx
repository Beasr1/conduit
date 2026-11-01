import { Hint } from "@/components/hint";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
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
// required, as a parameter the transform can't do without. What each part is
// for is a hint, and what it reads starts folded (plan 13).
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
      <p className="font-mono text-sm">
        {edge.from}
        {http && ` ${edge.unhandled ? "Unhandled" : (edge.on ?? "2xx")}`} →{" "}
        {edge.to}
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
            <div className="flex items-center gap-1">
              <FieldLabel htmlFor="connection-required">Required</FieldLabel>
              <Hint about="Required">
                {edge.to} runs only once this line came, so its expression can
                read {edge.from} without checking. Unmarked, {edge.to} may run
                without it, once another line came.
              </Hint>
            </div>
            <FieldError errors={asErrors(required)} />
          </FieldContent>
        </Field>
      )}
      <MappingField
        id="connection-when"
        label="Condition"
        hint={
          <>
            JSONata over what {edge.from} and the steps before it got back: the
            line is taken only when it&apos;s true. Empty means always.
          </>
        }
        folded
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

// Taken says whether a run would take the connection, with these samples,
// and when that skips the step it goes to.
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
    <p>
      {preview.skipped
        ? `${from} is skipped with these samples.`
        : preview.taken === undefined
          ? "Can't tell yet."
          : preview.taken
            ? "Taken, with these samples."
            : join === "needed" || join === "required"
              ? `Not taken, with these samples, so ${to} is skipped.`
              : "Not taken, with these samples."}
    </p>
  );
}
