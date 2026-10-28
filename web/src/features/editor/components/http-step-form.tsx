import { zodResolver } from "@hookform/resolvers/zod";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Controller,
  useFieldArray,
  useForm,
  type UseFormReturn,
  useWatch,
} from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { updateNode } from "@/features/editor/edits";
import {
  MAX_ATTEMPTS,
  METHODS,
  MIN_ATTEMPTS,
  type RequestValues,
  requestSchema,
  toRequest,
  toRequestValues,
  whole,
} from "@/features/editor/fields";
import { useEditor, useEditorStore } from "@/features/editor/store";

// HttpStepForm edits an http step's request. Each change goes into the draft
// as it's made, and the canvas follows.
export function HttpStepForm({ index }: { index: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const [defaultValues] = useState(() =>
    toRequestValues(editor.getState().draft.nodes[index]?.request),
  );
  const form = useForm<RequestValues>({
    resolver: zodResolver(requestSchema),
    defaultValues,
    mode: "onChange",
  });
  useEffect(
    () =>
      form.subscribe({
        formState: { values: true },
        callback: ({ values }) =>
          edit((d) =>
            updateNode(d, index, (n) => ({
              ...n,
              request: toRequest(n.request, values),
            })),
          ),
      }),
    [form, edit, index],
  );
  const { errors } = form.formState;
  const attempts = useWatch({ control: form.control, name: "attempts" });
  const retries =
    typeof whole(attempts, MIN_ATTEMPTS, MAX_ATTEMPTS) === "number";

  return (
    <FieldGroup className="gap-5">
      <Field>
        <FieldLabel htmlFor="step-url">URL</FieldLabel>
        <div className="flex gap-2">
          <Controller
            control={form.control}
            name="method"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(method) => field.onChange(method)}
              >
                <SelectTrigger aria-label="Method" className="font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m} value={m} className="font-mono">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <Input
            id="step-url"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://api.example.com/v1/users"
            {...form.register("url")}
          />
        </div>
        <FieldDescription>
          Absolute, http or https. {"{{ }}"} holds JSONata, in the path and
          query only.
        </FieldDescription>
      </Field>
      <Rows form={form} name="headers" noun="Header" legend="Headers" />
      <Rows form={form} name="query" noun="Parameter" legend="Query" />
      <Field>
        <FieldLabel htmlFor="step-body">Body</FieldLabel>
        {/* TODO(plan 10): a JSONata editor replaces this textarea. */}
        <Textarea
          id="step-body"
          className="min-h-24 font-mono"
          spellCheck={false}
          {...form.register("body")}
        />
        <FieldDescription>
          JSONata, sent as the JSON body. Empty sends none.
        </FieldDescription>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field data-invalid={!!errors.timeout}>
          <FieldLabel htmlFor="step-timeout">Timeout (ms)</FieldLabel>
          <Input
            id="step-timeout"
            inputMode="numeric"
            placeholder="30000"
            aria-invalid={!!errors.timeout}
            {...form.register("timeout")}
          />
          <FieldError errors={[errors.timeout]} />
          <FieldDescription>For each attempt.</FieldDescription>
        </Field>
        <Field data-invalid={!!errors.attempts}>
          <FieldLabel htmlFor="step-attempts">Attempts</FieldLabel>
          <Input
            id="step-attempts"
            inputMode="numeric"
            placeholder="1"
            aria-invalid={!!errors.attempts}
            {...form.register("attempts")}
          />
          <FieldError errors={[errors.attempts]} />
          <FieldDescription>
            The first included. Retries follow timeouts, transport errors, 429
            and 5xx.
          </FieldDescription>
        </Field>
      </div>
      <Field orientation="horizontal" data-disabled={!retries}>
        <Controller
          control={form.control}
          name="idempotent"
          render={({ field }) => (
            <Checkbox
              id="step-idempotent"
              checked={field.value}
              disabled={!retries}
              onCheckedChange={(on) => field.onChange(on)}
            />
          )}
        />
        <FieldContent>
          <FieldLabel htmlFor="step-idempotent">Idempotent</FieldLabel>
          <FieldDescription>
            The upstream treats a repeat as one request, so POST and PATCH are
            retried too, with an Idempotency-Key header.
          </FieldDescription>
        </FieldContent>
      </Field>
    </FieldGroup>
  );
}

// Rows edits a map as rows. Each row is keyed by the id its field array gave
// it, not its place, so removing one leaves the others' text alone.
function Rows({
  form,
  name,
  noun,
  legend,
}: {
  form: UseFormReturn<RequestValues>;
  name: "headers" | "query";
  noun: string;
  legend: string;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name,
  });
  const errors = form.formState.errors[name];
  const lower = noun.toLowerCase();
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">{legend}</FieldLegend>
      {fields.map((row, i) => (
        <div key={row.id} className="flex flex-col gap-1">
          <div className="flex gap-2">
            <Input
              aria-label={`${noun} ${i + 1} name`}
              placeholder="Name"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!errors?.[i]?.name}
              {...form.register(`${name}.${i}.name`)}
            />
            <Input
              aria-label={`${noun} ${i + 1} value`}
              placeholder="Value"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              {...form.register(`${name}.${i}.value`)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${lower} ${i + 1}`}
              onClick={() => remove(i)}
            >
              <XIcon />
            </Button>
          </div>
          <FieldError errors={[errors?.[i]?.name]} />
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => append({ name: "", value: "" })}
      >
        Add {lower}
      </Button>
    </FieldSet>
  );
}
