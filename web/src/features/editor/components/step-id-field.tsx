import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { mentions, NODE_ID } from "@/features/editor/edits";
import { useEditor, useEditorStore } from "@/features/editor/store";

// StepIdField edits the id other steps read this one by. It's checked as
// it's typed but applied when the field is left, or on Enter: a half-typed
// id would rename the step's edges on every key.
export function StepIdField({ index }: { index: number }) {
  const editor = useEditorStore();
  const rename = useEditor((s) => s.rename);
  const draft = useEditor((s) => s.draft);
  const id = draft.nodes[index]?.id ?? "";
  // The ids this step had before, while its settings are open.
  const [before, setBefore] = useState<string[]>([]);
  const [schema] = useState(() =>
    z.object({
      id: z
        .string()
        .regex(
          NODE_ID,
          "A lowercase letter, then up to 63 lowercase letters, digits and underscores.",
        )
        .refine(
          (next) =>
            !editor
              .getState()
              .draft.nodes.some((n, i) => i !== index && n.id === next),
          "Another step already has this id.",
        ),
    }),
  );
  const form = useForm<{ id: string }>({
    resolver: zodResolver(schema),
    defaultValues: { id },
    mode: "onChange",
  });
  const { errors } = form.formState;

  // An old id that another step has taken since is that step's to be read
  // by, so it's not reported.
  const stale = useMemo(
    () =>
      before
        .filter((old) => !draft.nodes.some((n) => n.id === old))
        .map((old) => ({ old, places: mentions(draft, old) }))
        .filter((s) => s.places.length > 0),
    [before, draft],
  );

  async function apply() {
    const next = form.getValues("id");
    if (next === id || !(await form.trigger("id"))) return;
    rename(index, next);
    setBefore((ids) => (ids.includes(id) ? ids : [...ids, id]));
  }

  return (
    <Field data-invalid={!!errors.id}>
      <FieldLabel htmlFor="step-id">Id</FieldLabel>
      <Input
        id="step-id"
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!errors.id}
        {...form.register("id", { onBlur: () => void apply() })}
        onKeyDown={(e) => {
          if (e.key === "Enter") void apply();
        }}
      />
      <FieldError errors={[errors.id]} />
      <FieldDescription>
        Other steps read its result as nodes.{id}.body.
      </FieldDescription>
      {stale.map(({ old, places }) => (
        <p key={old} role="status" className="text-sm">
          Still reading nodes.{old}: {places.join(", ")}. Change them to nodes.
          {id}.
        </p>
      ))}
    </Field>
  );
}
