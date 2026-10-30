import {
  JsonBlock,
  MappingField,
  Skipped,
} from "@/features/editor/components/mapping-field";
import { StepConnections } from "@/features/editor/components/step-connections";
import { parents, updateNode } from "@/features/editor/edits";
import { atStep, useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";

// TransformStepForm edits a transform step's expression between the data it
// reads and the value it gives, simulated over the samples, then lists what
// follows it. The expression goes into the draft as it's typed.
export function TransformStepForm({ index }: { index: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const preview = usePreview({ step: index });
  const problems = useProblems(atStep(index, "expr"));
  return (
    <>
      <MappingField
        id="step-expr"
        label="Expression"
        description={
          <>
            JSONata over the input. Steps after this one read its value as{" "}
            <span className="font-mono">{`nodes.${id}.body`}</span>.
          </>
        }
        initial={editor.getState().draft.nodes[index]?.expr ?? ""}
        apply={(text) =>
          edit((d) => updateNode(d, index, (n) => ({ ...n, expr: text })))
        }
        problems={problems}
        preview={preview}
        open={(of) => parents(of, of.nodes[index]?.id)}
        result={(p) =>
          p.skipped ? (
            <Skipped />
          ) : (
            <>
              <h3 className="font-medium">It gives</h3>
              {p.gives === undefined ? (
                <p className="text-muted-foreground">Nothing.</p>
              ) : (
                <JsonBlock value={p.gives} />
              )}
            </>
          )
        }
      />
      <StepConnections index={index} />
    </>
  );
}
