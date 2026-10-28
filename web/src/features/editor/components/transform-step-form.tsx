import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { updateNode } from "@/features/editor/edits";
import { useEditor, useEditorStore } from "@/features/editor/store";

// TransformStepForm edits a transform step's expression, which goes into the
// draft as it's typed.
export function TransformStepForm({ index }: { index: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const [defaultValues] = useState(() => ({
    expr: editor.getState().draft.nodes[index]?.expr ?? "",
  }));
  const form = useForm<{ expr: string }>({ defaultValues });
  useEffect(
    () =>
      form.subscribe({
        formState: { values: true },
        callback: ({ values }) =>
          edit((d) =>
            updateNode(d, index, (n) => ({ ...n, expr: values.expr })),
          ),
      }),
    [form, edit, index],
  );

  return (
    <Field>
      <FieldLabel htmlFor="step-expr">Expression</FieldLabel>
      {/* TODO(plan 10): a JSONata editor replaces this textarea. */}
      <Textarea
        id="step-expr"
        className="min-h-32 font-mono"
        spellCheck={false}
        {...form.register("expr")}
      />
      <FieldDescription>
        JSONata over the run's input and the steps before this one. Its value is
        this step's result.
      </FieldDescription>
    </Field>
  );
}
