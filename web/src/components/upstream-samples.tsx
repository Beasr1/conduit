import { useState } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { components } from "@/gen/schema";

type Upstream = components["schemas"]["Upstream"];

// Samples is what an upstream is made with besides its call (plan 07): its
// sample input, one JSON object with a value for each parameter by name,
// and a sample of each response the API can give, its 2xx first, as text
// while it's typed.
export interface Samples {
  input: string;
  responses: { status: string; body: string }[];
}

export const NO_SAMPLES: Samples = {
  input: "",
  responses: [{ status: "200", body: "" }],
};

// SamplesSaid is what's wrong with samples, by the field it shows under.
export interface SamplesSaid {
  input?: string;
  responses: { status?: string; body?: string }[];
}

// parse is text's JSON value, or undefined while it isn't JSON.
function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// checkSamples says what's wrong with samples for an upstream with these
// parameters: an input that isn't an object of them, a status out of its
// range or listed twice, a body that isn't JSON. Empty is no sample.
export function checkSamples(
  s: Samples,
  parameters: readonly string[],
): SamplesSaid {
  const said: SamplesSaid = { responses: s.responses.map(() => ({})) };
  if (s.input.trim() !== "") {
    const v = parse(s.input);
    const unknown = isObject(v)
      ? Object.keys(v).find((k) => !parameters.includes(k))
      : undefined;
    if (!isObject(v))
      said.input =
        'A JSON object, with a value for each parameter, such as { "user_id": "7" }.';
    else if (unknown !== undefined)
      said.input =
        parameters.length === 0
          ? `The URL reads no parameter, so there's none named ${unknown}.`
          : `No parameter is named ${unknown}: the URL reads ${parameters.join(", ")}.`;
  }
  s.responses.forEach((r, k) => {
    const text = r.status.trim();
    const status = Number(text);
    const mine = said.responses[k]!;
    if (!/^\d{3}$/.test(text)) mine.status = "A status: three digits.";
    else if (k === 0 && (status < 200 || status > 299))
      mine.status = "The first is its 2xx: 200 to 299.";
    else if (k > 0 && (status < 300 || status > 599))
      mine.status = "300 to 599: its 2xx is the first.";
    else if (s.responses.findIndex((x) => x.status.trim() === text) !== k)
      mine.status = "Listed already.";
    if (r.body.trim() !== "" && parse(r.body) === undefined)
      mine.body = 'A body is JSON, such as { "id": "7" }.';
  });
  return said;
}

// says is whether checkSamples found anything wrong.
export const says = (said: SamplesSaid) =>
  said.input !== undefined ||
  said.responses.some((r) => r.status !== undefined || r.body !== undefined);

// withSamples is u with the samples it's made with: each parameter's from
// the input, the 2xx sample, and a response for every other status, with
// its sample if it has one. Checked first.
export function withSamples(u: Upstream, s: Samples): Upstream {
  const input = s.input.trim() === "" ? {} : (parse(s.input) as object);
  const body = (text: string) =>
    text.trim() === "" ? undefined : (parse(text) as unknown);
  const out: Upstream = { ...u };
  if (u.parameters)
    out.parameters = u.parameters.map((p) =>
      Object.hasOwn(input, p.name)
        ? { ...p, sample: (input as Record<string, unknown>)[p.name] }
        : p,
    );
  const [first, ...rest] = s.responses;
  const sample = first && body(first.body);
  if (first && sample !== undefined)
    out.sample = {
      ...(Number(first.status) !== 200 && { status: Number(first.status) }),
      body: sample,
    };
  const outputs = rest.map((r) => {
    const b = body(r.body);
    return {
      status: Number(r.status),
      ...(b !== undefined && { sample: { body: b } }),
    };
  });
  if (outputs.length > 0) out.outputs = outputs;
  return out;
}

// SampleInputField is an upstream's sample input as text: one JSON object,
// a value for each parameter by name.
function SampleInputField({
  id,
  text,
  onChange,
  parameters,
  said,
}: {
  id: string;
  text: string;
  onChange: (text: string) => void;
  parameters: readonly string[];
  said: string[];
}) {
  return (
    <Field data-invalid={said.length > 0}>
      <div className="flex items-center gap-1">
        <FieldLabel htmlFor={`${id}-sample-input`}>Sample input</FieldLabel>
        <Hint about="Sample input">
          One JSON object, a value for each parameter by name: what previews
          give the parameters. Runs don&apos;t read it.
        </Hint>
      </div>
      <Textarea
        id={`${id}-sample-input`}
        className="min-h-16 font-mono"
        spellCheck={false}
        placeholder={`{ ${(parameters.length > 0 ? parameters : ["user_id"]).map((p) => `"${p}": …`).join(", ")} }`}
        aria-invalid={said.length > 0}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldError errors={said.map((message) => ({ message }))} />
    </Field>
  );
}

// SampleInput edits the samples of an upstream's parameters as one object,
// applied as it's typed once it's an object of them; until then they stay,
// and the field says why. problems are the server's.
export function SampleInput({
  id,
  parameters,
  samples,
  onChange,
  problems,
}: {
  id: string;
  parameters: readonly string[];
  samples: Record<string, unknown>;
  onChange: (samples: Record<string, unknown>) => void;
  problems: string[];
}) {
  const [text, setText] = useState(() =>
    Object.keys(samples).length === 0 ? "" : JSON.stringify(samples, null, 2),
  );
  const own = checkSamples({ input: text, responses: [] }, parameters).input;
  return (
    <SampleInputField
      id={id}
      text={text}
      onChange={(next) => {
        setText(next);
        if (
          checkSamples({ input: next, responses: [] }, parameters).input ===
          undefined
        )
          onChange(
            next.trim() === "" ? {} : (parse(next) as Record<string, unknown>),
          );
      }}
      parameters={parameters}
      said={own === undefined ? problems : [own]}
    />
  );
}

// UpstreamSamples takes an upstream's samples where it's made: its sample
// input, and a sample of each response the API can give, as its
// documentation says, which previews read and runs don't. Checked when
// it's made.
export function UpstreamSamples({
  id,
  value,
  onChange,
  parameters,
  said,
}: {
  id: string;
  value: Samples;
  onChange: (next: Samples) => void;
  parameters: readonly string[];
  said: SamplesSaid;
}) {
  const respond = (k: number, part: "status" | "body", text: string) =>
    onChange({
      ...value,
      responses: value.responses.with(k, {
        ...value.responses[k]!,
        [part]: text,
      }),
    });
  return (
    <>
      <SampleInputField
        id={id}
        text={value.input}
        onChange={(input) => onChange({ ...value, input })}
        parameters={parameters}
        said={said.input === undefined ? [] : [said.input]}
      />
      <section aria-label="Responses" className="flex flex-col gap-2 text-sm">
        <div className="flex items-center gap-1">
          <h3 className="font-medium">Responses</h3>
          <Hint about="Responses">
            What the API answers, as its documentation says: its 2xx first, then
            each status a step can follow. Each body is a sample previews read.
          </Hint>
        </div>
        <div className="flex gap-2 text-muted-foreground">
          <span className="w-20">Status</span>
          <span className="flex-1">Body</span>
          <span className="w-16" />
        </div>
        {value.responses.map((r, k) => {
          const mine = said.responses[k] ?? {};
          return (
            <div key={k} className="flex flex-col gap-1">
              <div className="flex items-start gap-2">
                <Input
                  aria-label={`Response ${k + 1} status`}
                  className="w-20 font-mono"
                  inputMode="numeric"
                  aria-invalid={mine.status !== undefined}
                  value={r.status}
                  onChange={(e) => respond(k, "status", e.target.value)}
                />
                <Textarea
                  aria-label={`Response ${k + 1} body`}
                  className="min-h-16 flex-1 font-mono"
                  spellCheck={false}
                  placeholder={
                    k === 0 ? '{ "id": "7" }' : '{ "error": "not found" }'
                  }
                  aria-invalid={mine.body !== undefined}
                  value={r.body}
                  onChange={(e) => respond(k, "body", e.target.value)}
                />
                {k === 0 ? (
                  <span className="w-16" />
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="w-16"
                    aria-label={`Remove response ${k + 1}`}
                    onClick={() =>
                      onChange({
                        ...value,
                        responses: value.responses.filter((_, j) => j !== k),
                      })
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>
              <FieldError
                errors={[mine.status, mine.body]
                  .filter((m) => m !== undefined)
                  .map((message) => ({ message }))}
              />
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            onChange({
              ...value,
              responses: [...value.responses, { status: "", body: "" }],
            })
          }
        >
          Add a response
        </Button>
      </section>
    </>
  );
}
