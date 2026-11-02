import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";

// A stop of the tour: the part of the editor it points at, by selector, the
// side of it the stop shows on, and what it says of it.
interface Stop {
  at: string;
  side: "top" | "bottom" | "right" | "left";
  title: string;
  text: string;
}

// The tour (plan 13): what a newcomer needs to learn of the editor, now
// that its panels don't explain themselves, a sentence a stop.
const STOPS: Stop[] = [
  // The canvas fills the page, so its stop points at the toolbar on it.
  {
    at: ".react-flow__panel.top.left",
    side: "bottom",
    title: "The canvas",
    text: "Each step calls an API, or transforms what the steps before it got. Lines say what runs next.",
  },
  {
    // Above it, as its responses are on its right.
    at: ".react-flow__node [data-part='request']",
    side: "top",
    title: "A step's call",
    text: "An HTTP step calls an upstream, an API saved in the library: click it to give the upstream's parameters values, or to edit the upstream.",
  },
  {
    at: ".react-flow__node [data-part='2xx']",
    side: "right",
    title: "Its responses",
    text: "Each status is a condition: when the API answers it, the lines from it run. Any other goes to Unhandled.",
  },
  {
    at: ".react-flow__node [data-part='2xx']",
    side: "right",
    title: "Connecting",
    text: "Drag from a status's point to a step, or pick the step in Connect to.",
  },
  {
    at: "[data-testid='rf__node-#response']",
    side: "left",
    title: "The response",
    text: "What your API answers. Join each answer to the steps that give it; a run gives the first one reached, top to bottom.",
  },
];

// A stop on screen, with the element it points at.
interface Shown extends Stop {
  part: Element;
}

// Tour shows the stops whose parts are on screen, one at a time from the
// first, while it's open. Skip, Done or Escape closes it.
export function Tour({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [stops, setStops] = useState<Shown[]>([]);
  const [k, setK] = useState(0);
  // The stops are found a frame after it opens, once the canvas has drawn
  // its steps.
  // Each points at the element itself: Base UI reads an anchor given as a
  // function once, and an element each time it changes.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      setStops(
        STOPS.flatMap((s) => {
          const part = document.querySelector(s.at);
          return part ? [{ ...s, part }] : [];
        }),
      );
      setK(0);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const stop = stops[k];
  if (!open || stop === undefined) return null;
  // Opened again, it finds its stops afresh, as the canvas may have changed.
  const close = () => {
    setStops([]);
    onClose();
  };
  const last = k === stops.length - 1;
  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {/* nokey: Delete or Backspace on its buttons would otherwise delete
          what's selected on the canvas. */}
      <PopoverContent
        anchor={stop.part}
        side={stop.side}
        align="start"
        className="nokey w-72"
      >
        <PopoverHeader>
          <span className="text-xs text-muted-foreground">
            {k + 1} of {stops.length}
          </span>
          <PopoverTitle>{stop.title}</PopoverTitle>
          <PopoverDescription>{stop.text}</PopoverDescription>
        </PopoverHeader>
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={close}>
            Skip
          </Button>
          <div className="flex gap-2">
            {k > 0 && (
              <Button variant="outline" size="sm" onClick={() => setK(k - 1)}>
                Back
              </Button>
            )}
            <Button size="sm" onClick={() => (last ? close() : setK(k + 1))}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
