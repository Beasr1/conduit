import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { setField } from "@/features/editor/edits";
import { asErrors, useProblems } from "@/features/editor/hooks/use-problems";
import { readSchema, showSchema } from "@/features/editor/fields";
import { useEditor, useEditorStore } from "@/features/editor/store";

// JsonField edits one of the workflow's JSON Schemas as text. The text counts
// once it's a JSON object; until then the stored schema stays, and the field
// says why. Nothing typed is eaten, since the field keeps its own text.
export function JsonField({
  id,
  label,
  field,
  description,
}: {
  id: string;
  label: string;
  field: "input_schema" | "output_schema";
  description: string;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const [text, setText] = useState(() =>
    showSchema(editor.getState().draft[field]),
  );
  const { schema, error } = readSchema(text);
  // The field's own check is about text that doesn't count yet; the
  // server's, about the schema the workflow holds.
  const found = useProblems(
    (p) => (p.on === "response" || p.on === "settings") && p.field === field,
  );
  const said = error === undefined ? asErrors(found) : [{ message: error }];

  function change(next: string) {
    setText(next);
    const read = readSchema(next);
    if (read.error === undefined) edit((d) => setField(d, field, read.schema));
  }

  return (
    <Field data-invalid={said.length > 0}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={schema === undefined}
          onClick={() => setText(showSchema(schema))}
        >
          Format
        </Button>
      </div>
      <Textarea
        id={id}
        className="min-h-32 font-mono"
        spellCheck={false}
        aria-invalid={said.length > 0}
        value={text}
        onChange={(e) => change(e.target.value)}
      />
      <FieldError errors={said} />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}
