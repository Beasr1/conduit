import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { updateEdge } from "@/features/editor/edits";
import { asErrors, useProblems } from "@/features/editor/hooks/use-problems";
import { useEditor, useEditorStore } from "@/features/editor/store";

// ConnectionForm edits a connection's condition, which goes into the draft
// as it's typed. No text means the connection is always taken.
export function ConnectionForm({ index }: { index: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const edge = useEditor((s) => s.draft.edges?.[index]);
  const [defaultValues] = useState(() => ({
    when: editor.getState().draft.edges?.[index]?.when ?? "",
  }));
  const form = useForm<{ when: string }>({ defaultValues });
  useEffect(
    () =>
      form.subscribe({
        formState: { values: true },
        callback: ({ values }) =>
          edit((d) =>
            updateEdge(d, index, (e) => ({
              ...e,
              when: values.when.trim() === "" ? undefined : values.when,
            })),
          ),
      }),
    [form, edit, index],
  );
  const found = useProblems((p) => p.on === "connection" && p.index === index);
  const when = found.filter(
    (f) => f.place.on === "connection" && f.place.field === "when",
  );
  if (!edge) return null;

  return (
    <>
      <p className="text-sm">
        From <span className="font-mono">{edge.from}</span> to{" "}
        <span className="font-mono">{edge.to}</span>.
      </p>
      <FieldError errors={asErrors(found.filter((f) => !when.includes(f)))} />
      <Field data-invalid={when.length > 0}>
        <FieldLabel htmlFor="connection-when">Condition</FieldLabel>
        {/* TODO(plan 10): a JSONata editor replaces this textarea. */}
        <Textarea
          id="connection-when"
          className="min-h-24 font-mono"
          spellCheck={false}
          placeholder={`nodes.${edge.from}.status = 200`}
          aria-invalid={when.length > 0}
          {...form.register("when")}
        />
        <FieldError errors={asErrors(when)} />
        <FieldDescription>
          JSONata over what {edge.from} and the steps before it returned.{" "}
          {edge.to} runs only when this is true; empty means always. A step none
          of whose connections is taken is skipped, and so are the steps that
          wait only on it.
        </FieldDescription>
      </Field>
    </>
  );
}
