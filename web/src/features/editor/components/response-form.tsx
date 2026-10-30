import { JsonField } from "@/features/editor/components/json-field";
import {
  JsonBlock,
  MappingField,
} from "@/features/editor/components/mapping-field";
import { RunAnswered } from "@/features/editor/components/step-run";
import { reads, setField } from "@/features/editor/edits";
import { useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";

// ResponseForm edits what the workflow answers: its output, between the data
// it reads and the answer it makes, simulated over the samples, and the
// schema that output should match.
export function ResponseForm() {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const preview = usePreview();
  const problems = useProblems(
    (p) => p.on === "response" && p.field === "output",
  );
  return (
    <>
      <RunAnswered />
      <MappingField
        id="response-output"
        label="Output"
        description={
          <>
            JSONata over every step that succeeded, read by name, such as{" "}
            <span className="font-mono">nodes.crm.body</span>. Its value is what
            the workflow answers; empty answers null.
          </>
        }
        placeholder='{ "user": nodes.user.body }'
        initial={editor.getState().draft.output ?? ""}
        apply={(text) =>
          edit((d) =>
            setField(d, "output", text.trim() === "" ? undefined : text),
          )
        }
        problems={problems}
        preview={preview}
        open={(of) => reads(of, of.output)}
        result={(p) => (
          <>
            <h3 className="font-medium">It answers</h3>
            {p.gives === undefined ? (
              <p className="text-muted-foreground">Nothing.</p>
            ) : (
              <JsonBlock value={p.gives} />
            )}
          </>
        )}
      />
      <JsonField
        id="response-schema"
        label="Output schema"
        field="output_schema"
        description="A JSON Schema the output should match. It's checked when saved; runs don't enforce it yet."
      />
    </>
  );
}
