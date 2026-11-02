import {
  JsonBlock,
  MappingField,
  Skipped,
  type Source,
} from "@/features/editor/components/mapping-field";
import { parents, updateNode } from "@/features/editor/edits";
import { atStep, useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Preview = components["schemas"]["Preview"];

// What the body of a step that uses an upstream reads (plan 07).
const PARAMETERS: Source = {
  title: "Parameters",
  about:
    "The upstream's parameters, which its request reads, with the values they take over the samples. Pick one to put its name in the request body.",
};

// StepBody edits an http step's request body between the data it reads and
// what the step sends, simulated over the samples: the input, the JSONata of
// the body, then the request as a run would send it. The body of a step
// that uses an upstream is the upstream's, and reads its parameters.
export function StepBody({ index }: { index: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const uses = useEditor((s) => s.draft.nodes[index]?.uses !== undefined);
  const preview = usePreview({ step: index });
  const problems = useProblems(atStep(index, "body"));
  return (
    <MappingField
      id="step-body"
      label="Request body"
      hint={`JSONata over ${uses ? "its parameters" : "the input"}, sent as the JSON body. Empty sends none.`}
      placeholder={
        uses ? '{ "email": email }' : '{ "email": nodes.user.body.email }'
      }
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
      result={(p) => <Sends preview={p} />}
      {...(uses && {
        reads: (p: Preview) => p.parameters ?? {},
        source: PARAMETERS,
      })}
    />
  );
}

// Sends is the request a step would send, as the preview renders it: what a
// body, or a parameter of an upstream it uses, makes of it.
export function Sends({ preview: p }: { preview: Preview }) {
  if (p.skipped) return <Skipped />;
  return (
    <>
      <h3 className="font-medium">Sends</h3>
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
  );
}
