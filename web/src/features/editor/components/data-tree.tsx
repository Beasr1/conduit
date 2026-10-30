import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { pathOf } from "@/features/editor/paths";

// How many items of an array the tree shows; the rest are counted.
const SHOWN = 50;

// DataTree shows JSON data as a tree. Each field and item is a button that
// hands over its JSONata path, to put in an expression; what holds more
// expands and collapses. The first three levels start open, so a step's body
// shows its fields: nodes › user › body › email, except the paths in folded.
export function DataTree({
  value,
  onPick,
  folded = new Set(),
}: {
  value: unknown;
  onPick: (path: string) => void;
  folded?: ReadonlySet<string>;
}) {
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-xs">
      <Children
        value={value}
        path=""
        depth={0}
        onPick={onPick}
        folded={folded}
      />
    </ul>
  );
}

function Children({
  value,
  path,
  depth,
  onPick,
  folded,
}: {
  value: unknown;
  path: string;
  depth: number;
  onPick: (path: string) => void;
  folded: ReadonlySet<string>;
}) {
  if (Array.isArray(value)) {
    const more = value.length - SHOWN;
    return (
      <>
        {value.slice(0, SHOWN).map((v, i) => (
          <Entry
            key={i}
            name={`[${i}]`}
            value={v}
            path={pathOf(path, i)}
            depth={depth}
            onPick={onPick}
            folded={folded}
          />
        ))}
        {more > 0 && <li className="text-muted-foreground">and {more} more</li>}
      </>
    );
  }
  if (isObject(value))
    return Object.entries(value).map(([key, v]) => (
      <Entry
        key={key}
        name={key}
        value={v}
        path={pathOf(path, key)}
        depth={depth}
        onPick={onPick}
        folded={folded}
      />
    ));
  return null;
}

function Entry({
  name,
  value,
  path,
  depth,
  onPick,
  folded,
}: {
  name: string;
  value: unknown;
  path: string;
  depth: number;
  onPick: (path: string) => void;
  folded: ReadonlySet<string>;
}) {
  const holds = Array.isArray(value)
    ? value.length > 0
    : isObject(value) && Object.keys(value).length > 0;
  const [open, setOpen] = useState(depth < 3 && !folded.has(path));
  return (
    <li>
      <div className="flex items-baseline gap-1">
        {holds ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${path}`}
            className="self-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5"
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <button
          type="button"
          aria-label={`Insert ${path}`}
          className="rounded-sm px-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={() => onPick(path)}
        >
          {name}
        </button>
        {!holds && (
          <span className="break-all text-muted-foreground">
            {JSON.stringify(value)}
          </span>
        )}
        {holds && !open && (
          <span className="text-muted-foreground">
            {Array.isArray(value) ? `[${value.length}]` : "{…}"}
          </span>
        )}
      </div>
      {holds && open && (
        <ul className="ml-4 flex flex-col gap-0.5">
          <Children
            value={value}
            path={path}
            depth={depth + 1}
            onPick={onPick}
            folded={folded}
          />
        </ul>
      )}
    </li>
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
