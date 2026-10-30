import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { JsonField } from "@/features/editor/components/json-field";
import { setField } from "@/features/editor/edits";
import { asErrors, useProblems } from "@/features/editor/hooks/use-problems";
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
  const found = useProblems((p) => p.on === "response" && p.field === "output");

  return (
    <>
      <Field data-invalid={found.length > 0}>
        <FieldLabel htmlFor="response-output">Output</FieldLabel>
        {/* TODO(plan 10): a JSONata editor replaces this textarea. */}
        <Textarea
          id="response-output"
          className="min-h-32 font-mono"
          spellCheck={false}
          placeholder='{ "user": nodes.user.body }'
          aria-invalid={found.length > 0}
          {...form.register("output")}
        />
        <FieldError errors={asErrors(found)} />
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
