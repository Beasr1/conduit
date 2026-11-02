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

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Marked } from "@/features/editor/components/problem-mark";
import { StepBody } from "@/features/editor/components/step-body";
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
import {
  asErrors,
  atStep,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import type { Place } from "@/features/editor/problems";
import { useEditor, useEditorStore } from "@/features/editor/store";

// HttpStepForm edits an http step's request: where it goes, what it
// sends, and how. Each change goes into the draft as it's made, and the
// canvas follows. The body isn't this form's: StepBody edits it, beside the
// data it reads, so each field is edited in one place. Its parts are a tab
// each (plan 13), the open one the editor's, so the problem list can open
// a field's; each stays mounted, so what's typed survives a switch.
// Locked, as the request of an upstream a step uses is, its fields are
// shown but not edited, and its tabs still open.
export function HttpStepForm({
  index,
  locked = false,
}: {
  index: number;
  locked?: boolean;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const tab = useEditor((s) => s.requestTab);
  const setTab = useEditor((s) => s.setRequestTab);
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
  // What the step holds, as the server found it. A field's own check comes
  // first where it has one: it's about text that doesn't count yet.
  const found = {
    method: useProblems(atStep(index, "method")),
    url: useProblems(atStep(index, "url")),
    timeout: useProblems(atStep(index, "timeout")),
    attempts: useProblems(atStep(index, "attempts")),
    idempotent: useProblems(atStep(index, "idempotent")),
  };
  const said = {
    url: asErrors([...found.method, ...found.url]),
    timeout: errors.timeout ? [errors.timeout] : asErrors(found.timeout),
    attempts: errors.attempts ? [errors.attempts] : asErrors(found.attempts),
    idempotent: asErrors(found.idempotent),
  };
  const attempts = useWatch({ control: form.control, name: "attempts" });
  const retries =
    typeof whole(attempts, MIN_ATTEMPTS, MAX_ATTEMPTS) === "number";
  const at =
    (...fields: string[]) =>
    (p: Place) =>
      p.on === "step" && p.index === index && fields.includes(p.field ?? "");

  return (
    <Tabs value={tab} onValueChange={(value: string) => setTab(value)}>
      <TabsList
        aria-label="Request"
        activateOnFocus
        className="flex-wrap group-data-horizontal/tabs:h-auto [&>[data-slot=tabs-trigger]]:h-auto"
      >
        <TabsTrigger value="url">
          URL
          <Marked where={at("method", "url")} />
        </TabsTrigger>
        <TabsTrigger value="headers">
          Headers
          <Marked where={at("headers")} />
        </TabsTrigger>
        <TabsTrigger value="query">
          Query
          <Marked where={at("query")} />
        </TabsTrigger>
        <TabsTrigger value="body">
          Body
          <Marked where={at("body")} />
        </TabsTrigger>
        <TabsTrigger value="retry">
          Retry
          <Marked where={at("timeout", "attempts", "idempotent")} />
        </TabsTrigger>
      </TabsList>
      <fieldset disabled={locked} className="contents">
        <TabsContent value="url" keepMounted>
          <Field data-invalid={said.url.length > 0}>
            <div className="flex items-center gap-1">
              <FieldLabel htmlFor="step-url">URL</FieldLabel>
              <Hint about="URL">
                Absolute, http or https. {"{{ }}"} holds JSONata, in the path
                and query only.
              </Hint>
            </div>
            <div className="flex gap-2">
              <Controller
                control={form.control}
                name="method"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(method) => field.onChange(method)}
                  >
                    <SelectTrigger
                      id="step-method"
                      aria-label="Method"
                      aria-invalid={found.method.length > 0}
                      className="font-mono"
                    >
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
                aria-invalid={found.url.length > 0}
                {...form.register("url")}
              />
            </div>
            <FieldError errors={said.url} />
          </Field>
        </TabsContent>
        <TabsContent value="headers" keepMounted>
          <Rows
            form={form}
            index={index}
            name="headers"
            noun="Header"
            legend="Headers"
          />
        </TabsContent>
        <TabsContent value="query" keepMounted>
          <Rows
            form={form}
            index={index}
            name="query"
            noun="Parameter"
            legend="Query"
          />
        </TabsContent>
        <TabsContent value="body" keepMounted className="flex flex-col gap-5">
          <StepBody index={index} />
        </TabsContent>
        <TabsContent value="retry" keepMounted>
          <FieldGroup className="gap-5">
            <div className="grid grid-cols-2 gap-3">
              <Field data-invalid={said.timeout.length > 0}>
                <div className="flex items-center gap-1">
                  <FieldLabel htmlFor="step-timeout">Timeout (ms)</FieldLabel>
                  <Hint about="Timeout">For each attempt.</Hint>
                </div>
                <Input
                  id="step-timeout"
                  inputMode="numeric"
                  placeholder="30000"
                  aria-invalid={said.timeout.length > 0}
                  {...form.register("timeout")}
                />
                <FieldError errors={said.timeout} />
              </Field>
              <Field data-invalid={said.attempts.length > 0}>
                <div className="flex items-center gap-1">
                  <FieldLabel htmlFor="step-attempts">Attempts</FieldLabel>
                  <Hint about="Attempts">
                    The first included. Retries follow timeouts, transport
                    errors, 429 and 5xx.
                  </Hint>
                </div>
                <Input
                  id="step-attempts"
                  inputMode="numeric"
                  placeholder="1"
                  aria-invalid={said.attempts.length > 0}
                  {...form.register("attempts")}
                />
                <FieldError errors={said.attempts} />
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
                <div className="flex items-center gap-1">
                  <FieldLabel htmlFor="step-idempotent">Idempotent</FieldLabel>
                  <Hint about="Idempotent">
                    The upstream treats a repeat as one request, so POST and
                    PATCH are retried too, with an Idempotency-Key header.
                  </Hint>
                </div>
                <FieldError errors={said.idempotent} />
              </FieldContent>
            </Field>
          </FieldGroup>
        </TabsContent>
      </fieldset>
    </Tabs>
  );
}

// Rows edits a map as rows. Each row is keyed by the id its field array gave
// it, not its place, so removing one leaves the others' text alone. The
// server names a header or parameter by its name, so its problems go under
// the first row with that name, and under the legend when no row has it.
function Rows({
  form,
  index,
  name,
  noun,
  legend,
}: {
  form: UseFormReturn<RequestValues>;
  index: number;
  name: "headers" | "query";
  noun: string;
  legend: string;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name,
  });
  const errors = form.formState.errors[name];
  const rows = useWatch({ control: form.control, name });
  const found = useProblems(atStep(index, name));
  const named = (row: string) =>
    found.filter((f) => f.place.on === "step" && f.place.name === row);
  const first = (i: number) =>
    rows.findIndex((r) => r.name === rows[i]?.name) === i;
  const homeless = found.filter(
    (f) => !rows.some((r) => f.place.on === "step" && f.place.name === r.name),
  );
  const lower = noun.toLowerCase();
  return (
    <FieldSet className="gap-2">
      {/* The tab says it; the legend names the rows for a screen reader. */}
      <FieldLegend variant="label" className="sr-only">
        {legend}
      </FieldLegend>
      <FieldError errors={asErrors(homeless)} />
      {fields.map((row, i) => {
        const mine = first(i) ? named(rows[i]?.name ?? "") : [];
        const badName =
          !!errors?.[i]?.name ||
          mine.some((f) => f.code === "invalid_header_name");
        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div className="flex gap-2">
              <Input
                id={`step-${name}-${i}-name`}
                aria-label={`${noun} ${i + 1} name`}
                placeholder="Name"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={badName}
                {...form.register(`${name}.${i}.name`)}
              />
              <Input
                id={`step-${name}-${i}-value`}
                aria-label={`${noun} ${i + 1} value`}
                placeholder="Value"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={mine.some(
                  (f) => f.code !== "invalid_header_name",
                )}
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
            <FieldError
              errors={errors?.[i]?.name ? [errors[i].name] : asErrors(mine)}
            />
          </div>
        );
      })}
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
