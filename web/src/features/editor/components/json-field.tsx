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

  function change(next: string) {
    setText(next);
    const read = readSchema(next);
    if (read.error === undefined) edit((d) => setField(d, field, read.schema));
  }

  return (
    <Field data-invalid={error !== undefined}>
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
        aria-invalid={error !== undefined}
        value={text}
        onChange={(e) => change(e.target.value)}
      />
      <FieldError>{error}</FieldError>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}
