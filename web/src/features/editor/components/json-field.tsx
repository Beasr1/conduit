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
import {
  type Read,
  readJSON,
  readSchema,
  showJSON,
} from "@/features/editor/fields";
import type { Found } from "@/features/editor/problems";
import { useEditor, useEditorStore } from "@/features/editor/store";

// JsonText edits a JSON value as text, starting from initial: what read
// makes of the text is applied once it counts, as a JSON Schema does once
// it's an object. Until then, the stored value stays and the field says why.
// Nothing typed is eaten, since the field keeps its own text. problems are
// the server's, about the value held.
export function JsonText<T>({
  id,
  label,
  description,
  initial,
  read,
  apply,
  problems,
}: {
  id: string;
  label: string;
  description: string;
  initial: T | undefined;
  read: (text: string) => Read<T>;
  apply: (value: T | undefined) => void;
  problems: Found[];
}) {
  const [text, setText] = useState(() => showJSON(initial));
  const { value, error } = read(text);
  // The field's own check is about text that doesn't count yet; the
  // server's, about the value the workflow holds.
  const said = error === undefined ? asErrors(problems) : [{ message: error }];

  function change(next: string) {
    setText(next);
    const { value, error } = read(next);
    if (error === undefined) apply(value);
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

// JsonField edits one of the workflow's own JSON fields: the input schema,
// or the sample input, which can be any JSON.
export function JsonField({
  id,
  label,
  field,
  description,
}: {
  id: string;
  label: string;
  field: "input_schema" | "sample_input";
  description: string;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const problems = useProblems((p) => p.on === "settings" && p.field === field);
  const shared = { id, label, description, problems };
  const draft = editor.getState().draft;
  return field === "sample_input" ? (
    <JsonText
      {...shared}
      initial={draft.sample_input}
      read={readJSON}
      apply={(value) => edit((d) => setField(d, "sample_input", value))}
    />
  ) : (
    <JsonText
      {...shared}
      initial={draft.input_schema}
      read={readSchema}
      apply={(value) => edit((d) => setField(d, "input_schema", value))}
    />
  );
}
