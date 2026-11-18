import { useState } from "react";

import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  kindOf,
  MASK_KINDS,
  type MaskKind,
  maskOf,
} from "@/features/editor/masks";
import type { components } from "@/gen/schema";

type Mask = components["schemas"]["Mask"];
type MaskedField = components["schemas"]["MaskedField"];

// MaskPicker is how a marked value is kept (plan 17): what kind of mask,
// and the characters it keeps at each end it keeps. of names what it masks,
// for the names of its controls. optional offers Not masked. In a row with
// room, inside a container (`@container`), it takes the same width
// whatever it shows, so the rows' columns line up.
export function MaskPicker({
  of,
  mask,
  optional,
  onChange,
}: {
  of: string;
  mask: Mask | undefined;
  optional: boolean;
  onChange: (mask: Mask | undefined) => void;
}) {
  const kind = kindOf(mask);
  const kinds = optional ? MASK_KINDS : MASK_KINDS.slice(1);
  // A number typed in, or nothing: until it is one, the field shows the last.
  const kept = (end: "start" | "end", text: string) => {
    const n = Number(text);
    if (text !== "" && Number.isInteger(n)) onChange({ ...mask, [end]: n });
  };
  return (
    <div className="flex items-center gap-2 @md:w-76">
      <Select<MaskKind>
        value={kind}
        onValueChange={(k) => k && onChange(maskOf(k, mask))}
      >
        <SelectTrigger aria-label={`Mask of ${of}`} className="w-40">
          <SelectValue>{MASK_KINDS.find(([k]) => k === kind)?.[1]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {kinds.map(([k, label]) => (
            <SelectItem key={k} value={k}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(["start", "end"] as const).map(
        (end) =>
          mask?.[end] !== undefined && (
            <Input
              key={end}
              type="number"
              min={1}
              max={8}
              className="w-16"
              aria-label={`Characters kept at the ${end} of ${of}`}
              value={mask[end]}
              onChange={(e) => kept(end, e.target.value)}
            />
          ),
      )}
    </div>
  );
}

// MaskedFields lists fields whose values are kept masked (plan 17), each
// with its mask, and adds one, offering the fields a sample has. problems
// is what the server says of each, by its place in the list. With room, a
// field is a row; without, as in the side panel, its mask goes under it.
export function MaskedFields({
  id,
  fields,
  offered,
  problems,
  onChange,
}: {
  id: string;
  fields: MaskedField[];
  offered: string[];
  problems: (k: number) => string[];
  onChange: (next: MaskedField[]) => void;
}) {
  const [added, setAdded] = useState("");
  const taken = fields.some((f) => f.field === added);
  const free = offered.filter((o) => !fields.some((f) => f.field === o));
  return (
    <div className="@container flex flex-col gap-2">
      {fields.map((f, k) => (
        <div key={k} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`Masked field ${f.field}`}
              className="w-full font-mono @md:w-auto @md:flex-1"
              autoComplete="off"
              spellCheck={false}
              value={f.field}
              onChange={(e) =>
                onChange(fields.with(k, { ...f, field: e.target.value }))
              }
            />
            <MaskPicker
              of={f.field}
              mask={f.mask}
              optional={false}
              onChange={(mask) =>
                onChange(fields.with(k, { ...f, mask: mask ?? {} }))
              }
            />
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto w-16"
              aria-label={`Stop masking ${f.field}`}
              onClick={() => onChange(fields.filter((_, j) => j !== k))}
            >
              Remove
            </Button>
          </div>
          <FieldError errors={problems(k).map((message) => ({ message }))} />
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (added === "" || taken) return;
          onChange([...fields, { field: added, mask: {} }]);
          setAdded("");
        }}
      >
        <Input
          id={id}
          aria-label="Add a masked field"
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          placeholder="customer.emirates_id"
          list={`${id}-offered`}
          value={added}
          onChange={(e) => setAdded(e.target.value.trim())}
        />
        <datalist id={`${id}-offered`}>
          {free.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
        <Button type="submit" variant="outline" size="sm" disabled={taken}>
          Add
        </Button>
      </form>
    </div>
  );
}
