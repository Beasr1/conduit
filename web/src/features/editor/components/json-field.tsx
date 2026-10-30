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
import { readJSON, readSchema, showJSON } from "@/features/editor/fields";
import { useEditor, useEditorStore } from "@/features/editor/store";

// JsonField edits one of the workflow's JSON fields as text: a JSON Schema,
// which counts once it's an object, or the sample input, which can be any
// JSON. Until the text counts, the stored value stays and the field says
// why. Nothing typed is eaten, since the field keeps its own text.
export function JsonField({
  id,
  label,
  field,
  description,
}: {
  id: string;
  label: string;
  field: "input_schema" | "output_schema" | "sample_input";
  description: string;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const read = field === "sample_input" ? readJSON : readSchema;
  const [text, setText] = useState(() =>
    showJSON(editor.getState().draft[field]),
  );
  const { value, error } = read(text);
  // The field's own check is about text that doesn't count yet; the
  // server's, about the schema the workflow holds.
  const found = useProblems(
    (p) => (p.on === "response" || p.on === "settings") && p.field === field,
  );
  const said = error === undefined ? asErrors(found) : [{ message: error }];

  function change(next: string) {
    setText(next);
    const { value, error } = read(next);
    if (error === undefined) edit((d) => setField(d, field, value));
  }

  return (
    <Field data-invalid={said.length > 0}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Format ${label.toLowerCase()}`}
          disabled={value === undefined}
          onClick={() => setText(showJSON(value))}
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
