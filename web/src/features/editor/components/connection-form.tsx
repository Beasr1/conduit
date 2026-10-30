import { FieldError } from "@/components/ui/field";
import { MappingField } from "@/features/editor/components/mapping-field";
import { updateEdge } from "@/features/editor/edits";
import { asErrors, useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Preview = components["schemas"]["Preview"];

// ConnectionForm edits a connection's condition between the data it reads
// and whether a run takes the connection, simulated over the samples: what
// its step and the steps before it got back, its step answering with the
// response the connection leaves from; the condition, which goes into the
// draft as it's typed; then whether it's taken. No text means it's taken
// whenever its step answers that way.
export function ConnectionForm({ index }: { index: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const edge = useEditor((s) => s.draft.edges?.[index]);
  const http = useEditor(
    (s) =>
      s.draft.nodes.find((n) => n.id === s.draft.edges?.[index]?.from)?.kind ===
      "http",
  );
  const preview = usePreview({ edge: index });
  const found = useProblems((p) => p.on === "connection" && p.index === index);
  const when = found.filter(
    (f) => f.place.on === "connection" && f.place.field === "when",
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
      <FieldError errors={asErrors(found.filter((f) => !when.includes(f)))} />
      <MappingField
        id="connection-when"
        label="Condition"
        description={
          <>
            JSONata over what {edge.from} and the steps before it got back.{" "}
            {edge.to} runs only when this is true; empty means always. A step
            none of whose connections is taken is skipped, and so are the steps
            that wait only on it.
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
        result={(p) => <Taken preview={p} from={edge.from} to={edge.to} />}
      />
    </>
  );
}

// Taken says whether a run would take the connection, with these samples.
function Taken({
  preview,
  from,
  to,
}: {
  preview: Preview;
  from: string;
  to: string;
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
              ? `Taken, so ${to} runs.`
              : `Not taken. ${to} runs only if another connection into it is.`}
      </p>
    </>
  );
}
