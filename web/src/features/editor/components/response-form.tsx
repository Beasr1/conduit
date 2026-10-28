import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { JsonField } from "@/features/editor/components/json-field";
import { setField } from "@/features/editor/edits";
import { useEditor, useEditorStore } from "@/features/editor/store";

// ResponseForm edits what the workflow answers: its output, built from the
// steps' results, and the schema that output should match.
export function ResponseForm() {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const [defaultValues] = useState(() => ({
    output: editor.getState().draft.output ?? "",
  }));
  const form = useForm<{ output: string }>({ defaultValues });
  useEffect(
    () =>
      form.subscribe({
        formState: { values: true },
        callback: ({ values }) =>
          edit((d) =>
            setField(
              d,
              "output",
              values.output.trim() === "" ? undefined : values.output,
            ),
          ),
      }),
    [form, edit],
  );

  return (
    <>
      <Field>
        <FieldLabel htmlFor="response-output">Output</FieldLabel>
        {/* TODO(plan 10): a JSONata editor replaces this textarea. */}
        <Textarea
          id="response-output"
          className="min-h-32 font-mono"
          spellCheck={false}
          placeholder='{ "user": nodes.user.body }'
          {...form.register("output")}
        />
        <FieldDescription>
          JSONata over every step that succeeded, read by name, such as
          nodes.crm.body. Its value is what the workflow answers; empty answers
          null.
        </FieldDescription>
      </Field>
      <JsonField
        id="response-schema"
        label="Output schema"
        field="output_schema"
        description="A JSON Schema the output should match. It's checked when saved; runs don't enforce it yet."
      />
    </>
  );
}
