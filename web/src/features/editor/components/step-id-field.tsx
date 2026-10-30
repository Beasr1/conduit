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
import { ID_RULE, ID_TAKEN, mentions, NODE_ID } from "@/features/editor/edits";
import {
  asErrors,
  atStep,
  useProblems,
} from "@/features/editor/hooks/use-problems";
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
        .regex(NODE_ID, ID_RULE)
        .refine(
          (next) =>
            !editor
              .getState()
              .draft.nodes.some((n, i) => i !== index && n.id === next),
          ID_TAKEN,
        ),
    }),
  );
  const form = useForm<{ id: string }>({
    resolver: zodResolver(schema),
    defaultValues: { id },
    mode: "onChange",
  });
  const { errors } = form.formState;
  // The form checks what's typed; the server, the id the step holds.
  const problems = useProblems(atStep(index, "id"));
  const said = errors.id ? [errors.id] : asErrors(problems);

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

  // apply renames the step to the id typed, when it's a valid one. It's
  // checked here at once rather than through the form, so a save that
  // follows straight after, on Ctrl-S, saves the new id.
  function apply() {
    const next = form.getValues("id");
    if (next === id || !schema.safeParse({ id: next }).success) return;
    rename(index, next);
    setBefore((ids) => (ids.includes(id) ? ids : [...ids, id]));
  }

  return (
    <Field data-invalid={said.length > 0}>
      <FieldLabel htmlFor="step-id">Id</FieldLabel>
      <Input
        id="step-id"
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={said.length > 0}
        {...form.register("id", { onBlur: apply })}
        onKeyDown={(e) => {
          const save = e.key.toLowerCase() === "s" && (e.ctrlKey || e.metaKey);
          if (e.key === "Enter" || save) apply();
        }}
      />
      <FieldError errors={said} />
      <FieldDescription>
        In expressions, this step is{" "}
        <span className="font-mono">{`nodes.${id}`}</span>.
      </FieldDescription>
      {stale.map(({ old, places }) => (
        <p key={old} role="status" className="text-sm">
          Still reading <span className="font-mono">nodes.{old}</span>:{" "}
          {places.join(", ")}. Change them to{" "}
          <span className="font-mono">nodes.{id}</span>.
        </p>
      ))}
    </Field>
  );
}
