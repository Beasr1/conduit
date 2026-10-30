import {
  JsonBlock,
  MappingField,
  Skipped,
} from "@/features/editor/components/mapping-field";
import { parents, updateNode } from "@/features/editor/edits";
import { atStep, useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";

// StepBody edits an http step's request body between the data it reads and
// what the step sends, simulated over the samples: the input, the JSONata of
// the body, then the request as a run would send it.
export function StepBody({ index }: { index: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const preview = usePreview({ step: index });
  const problems = useProblems(atStep(index, "body"));
  return (
    <MappingField
      id="step-body"
      label="Request body"
      description="JSONata over the input, sent as the JSON body. Empty sends none."
      placeholder='{ "email": nodes.user.body.email }'
      initial={editor.getState().draft.nodes[index]?.request?.body ?? ""}
      apply={(text) =>
        edit((d) =>
          updateNode(d, index, (n) =>
            n.request
              ? {
                  ...n,
                  request: {
                    ...n.request,
                    body: text === "" ? undefined : text,
                  },
                }
              : n,
          ),
        )
      }
      problems={problems}
      preview={preview}
      open={(of) => parents(of, of.nodes[index]?.id)}
      result={(p) =>
        p.skipped ? (
          <Skipped />
        ) : (
          <>
            <h3 className="font-medium">It sends</h3>
            {p.sends === undefined ? (
              <p className="text-muted-foreground">
                Nothing: the request doesn&apos;t render.
              </p>
            ) : (
              <>
                <p className="font-mono break-all">
                  {p.sends.method} {p.sends.url ?? "(the URL doesn't render)"}
                </p>
                {Object.keys(p.sends.headers).length > 0 && (
                  <dl className="flex flex-col gap-0.5">
                    {Object.entries(p.sends.headers).map(([name, value]) => (
                      <div key={name} className="font-mono break-all">
                        <dt className="inline">{name}: </dt>
                        <dd className="inline">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {p.sends.body === undefined ? (
                  <p className="text-muted-foreground">No body.</p>
                ) : (
                  <JsonBlock value={p.sends.body} />
                )}
              </>
            )}
          </>
        )
      }
    />
  );
}
