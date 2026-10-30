import { type ReactNode, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { DataTree } from "@/features/editor/components/data-tree";
import { Where } from "@/features/editor/components/problem-list";
import { asErrors } from "@/features/editor/hooks/use-problems";
import type { usePreview } from "@/features/editor/hooks/use-preview";
import { pathOf } from "@/features/editor/paths";
import { type Found, placeOf, say } from "@/features/editor/problems";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type Preview = components["schemas"]["Preview"];

// MappingField edits a JSONata expression between the data it reads and
// what it makes of that, simulated over the samples: the input, as a tree
// whose fields put their path where the cursor is; the expression, applied
// as it's typed; then the result. A step's request body, a transform's
// value, a connection's condition and the workflow's output are each
// written in one.
export function MappingField({
  id,
  label,
  description,
  placeholder,
  initial,
  apply,
  problems,
  preview,
  open,
  result,
}: {
  id: string;
  label: string;
  description: ReactNode;
  placeholder?: string;
  initial: string;
  apply: (text: string) => void;
  // The server's check of the expression itself.
  problems: Found[];
  preview: ReturnType<typeof usePreview>;
  // The steps whose data the tree opens, in the draft previewed, as those
  // most likely read; the rest start folded.
  open: (of: Definition) => string[];
  result: (preview: Preview) => ReactNode;
}) {
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  // Whether the field has had the cursor yet. A pick goes where the cursor
  // is, read from the field when the pick is made, since a field keeps its
  // selection when it loses focus; before it has had the cursor, at the end.
  const used = useRef(false);

  function change(next: string) {
    setText(next);
    apply(next);
  }

  function insert(path: string) {
    const el = field.current;
    const [start, end] =
      el && used.current
        ? [el.selectionStart, el.selectionEnd]
        : [text.length, text.length];
    // The new text is in the field before the cursor goes after the path,
    // so nothing typed in between can move it back.
    flushSync(() => change(text.slice(0, start) + path + text.slice(end)));
    const at = start + path.length;
    el?.focus();
    el?.setSelectionRange(at, at);
  }

  return (
    <>
      <section className="flex flex-col gap-1.5 text-sm">
        <h3 className="font-medium">Input</h3>
        <p className="text-muted-foreground">
          What it reads: the run&apos;s input, and what the steps before it got
          back. Pick a field to put its path in the {label.toLowerCase()}.
        </p>
        {preview.isPending ? (
          <Waiting />
        ) : preview.isError ? (
          <Failed message={preview.error.message} />
        ) : (
          <>
            <Problems preview={preview.data.preview} of={preview.data.of} />
            <div className="max-h-72 overflow-auto rounded-md bg-muted p-2">
              <DataTree
                value={preview.data.preview.reads}
                onPick={insert}
                folded={foldedOf(
                  preview.data.preview.reads,
                  open(preview.data.of),
                )}
              />
            </div>
          </>
        )}
      </section>
      <Field data-invalid={problems.length > 0}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {/* TODO(plan 10): a JSONata editor replaces this textarea. */}
        <Textarea
          id={id}
          ref={field}
          className="min-h-24 font-mono"
          spellCheck={false}
          placeholder={placeholder}
          aria-invalid={problems.length > 0}
          value={text}
          onChange={(e) => change(e.target.value)}
          onFocus={() => {
            used.current = true;
          }}
        />
        <FieldError errors={asErrors(problems)} />
        <FieldDescription>{description}</FieldDescription>
      </Field>
      {preview.data !== undefined && (
        <section className="flex flex-col gap-1.5 text-sm">
          {result(preview.data.preview)}
        </section>
      )}
    </>
  );
}

// foldedOf is the paths, in what a preview reads, of the steps not among
// open: the tree starts them folded.
function foldedOf(reads: unknown, open: string[]): Set<string> {
  const nodes =
    typeof reads === "object" && reads !== null && "nodes" in reads
      ? reads.nodes
      : undefined;
  const ids =
    typeof nodes === "object" && nodes !== null ? Object.keys(nodes) : [];
  return new Set(
    ids.filter((id) => !open.includes(id)).map((id) => pathOf("nodes", id)),
  );
}

// JsonBlock shows a JSON value as indented text, scrolling when it's long.
export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// Skipped says a run wouldn't start the step at all.
export function Skipped() {
  return (
    <p>
      With these samples, a run would skip this step: no connection into it is
      taken.
    </p>
  );
}

// Problems lists what got in the preview's way, each with where it is.
function Problems({ preview, of }: { preview: Preview; of: Definition }) {
  if (preview.problems.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {preview.problems.map((p, i) => (
        <li key={i}>
          <span className="font-medium">
            <Where place={placeOf(p.pointer)} draft={of} />
          </span>
          : <span className="text-destructive">{say(p, of)}</span>
        </li>
      ))}
    </ul>
  );
}

function Waiting() {
  return <p className="text-muted-foreground">Previewing…</p>;
}

function Failed({ message }: { message: string }) {
  return <p className="text-destructive">Couldn&apos;t preview: {message}</p>;
}
