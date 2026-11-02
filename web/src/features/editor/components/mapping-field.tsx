import { type ReactNode, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Hint } from "@/components/hint";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { DataTree } from "@/features/editor/components/data-tree";
import { Where } from "@/features/editor/components/problem-list";
import { outcomeTag } from "@/features/editor/flow";
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
// written in one. reads picks what of the preview it reads, its reads but
// for a step's Unhandled body, and source names it and says what it is when
// it isn't the run's input. What the expression is for is a hint beside its
// label (plan 13); a connection's input starts folded.
export function MappingField({
  id,
  label,
  hint,
  placeholder,
  initial,
  apply,
  problems,
  preview,
  open,
  result,
  reads = (p) => p.reads,
  source,
  folded = false,
}: {
  id: string;
  label: string;
  hint: ReactNode;
  placeholder?: string;
  initial: string;
  apply: (text: string) => void;
  // The server's check of the expression itself.
  problems: Found[];
  preview: ReturnType<typeof usePreview>;
  // The steps whose data the tree opens, in the draft previewed, as those
  // most likely read; the rest start folded.
  open: (of: Definition) => string[];
  // What it makes of that, given the preview and the draft previewed.
  result: (preview: Preview, of: Definition) => ReactNode;
  reads?: (preview: Preview) => unknown;
  source?: Source;
  folded?: boolean;
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
      <Reads
        into={`the ${label.toLowerCase()}`}
        preview={preview}
        open={open}
        onPick={insert}
        reads={reads}
        source={source}
        folded={folded}
      />
      <Field data-invalid={problems.length > 0}>
        <div className="flex items-center gap-1">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Hint about={label}>{hint}</Hint>
        </div>
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
      </Field>
      {preview.data !== undefined && (
        <section className="flex flex-col gap-1.5 text-sm">
          {result(preview.data.preview, preview.data.of)}
        </section>
      )}
    </>
  );
}

// Source is what an expression reads when it isn't the run's input: its
// name, and what it is.
export interface Source {
  title: string;
  about: ReactNode;
}

// Reads is what an expression reads, simulated over the samples: the run's
// input, and what the steps before it got back, as a tree whose fields
// give their path, which goes into what into names. The steps open names
// start unfolded. A step a run may come without, or that may answer more
// than one way, is tagged so, and the hint says what to check. Folded, it
// waits to be opened. Reading something else, source names it.
export function Reads({
  into,
  preview,
  open,
  onPick,
  reads = (p) => p.reads,
  source,
  folded = false,
}: {
  into: string;
  preview: ReturnType<typeof usePreview>;
  open: (of: Definition) => string[];
  onPick: (path: string) => void;
  reads?: (preview: Preview) => unknown;
  source?: Source;
  folded?: boolean;
}) {
  const title = source?.title ?? "Input";
  const body = (
    <>
      {preview.isPending ? (
        <Waiting />
      ) : preview.isError ? (
        <Failed message={preview.error.message} />
      ) : (
        <>
          <Problems preview={preview.data.preview} of={preview.data.of} />
          <div className="max-h-72 overflow-auto rounded-md bg-muted p-2">
            <DataTree
              value={reads(preview.data.preview)}
              onPick={onPick}
              folded={foldedOf(
                reads(preview.data.preview),
                open(preview.data.of),
              )}
              tags={tagsOf(
                reads(preview.data.preview),
                preview.data.preview,
                preview.data.of,
              )}
            />
          </div>
        </>
      )}
    </>
  );
  if (folded)
    return (
      <details className="flex flex-col gap-1.5 text-sm">
        <summary className="cursor-pointer font-medium">{title}</summary>
        <div className="mt-1.5 flex flex-col gap-1.5">{body}</div>
      </details>
    );
  return (
    <section className="flex flex-col gap-1.5 text-sm">
      <div className="flex items-center gap-1">
        <h3 className="font-medium">{title}</h3>
        <Hint about={title}>
          {source?.about ?? (
            <>
              The run&apos;s input, and what the steps before got back. Pick a
              field to put its path in {into}. A step tagged conditional may not
              be there, so check it with{" "}
              <span className="font-mono">$exists</span>; one tagged with its
              responses may have answered any of them.
            </>
          )}
        </Hint>
      </div>
      {body}
    </section>
  );
}

// foldedOf is the paths, in what a preview reads, of the steps not among
// open: the tree starts them folded.
function foldedOf(reads: unknown, open: string[]): Set<string> {
  return new Set(
    stepsIn(reads)
      .filter((id) => !open.includes(id))
      .map((id) => pathOf("nodes", id)),
  );
}

// stepsIn is the ids of the steps in what a preview reads.
function stepsIn(reads: unknown): string[] {
  const nodes =
    typeof reads === "object" && reads !== null && "nodes" in reads
      ? reads.nodes
      : undefined;
  return typeof nodes === "object" && nodes !== null ? Object.keys(nodes) : [];
}

// tagsOf is the tags of the steps in what a preview reads, by their paths
// there, from what each may have done in a run that reaches the step.
function tagsOf(
  reads: unknown,
  preview: Preview,
  of: Definition,
): Map<string, string> {
  const tags = new Map<string, string>();
  for (const id of stepsIn(reads)) {
    const outcome = preview.outcomes?.[id];
    const tag =
      outcome &&
      outcomeTag(
        of.nodes.find((n) => n.id === id),
        outcome,
      );
    if (tag) tags.set(pathOf("nodes", id), tag);
  }
  return tags;
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
  return <p>Skipped with these samples.</p>;
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
