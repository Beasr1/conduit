import { CircleAlertIcon } from "lucide-react";

import { useProblemCount } from "@/features/editor/hooks/use-problems";
import type { Place } from "@/features/editor/problems";

// ProblemMark marks something with problems: an icon, and words for screen
// readers, since colour alone isn't a signal. The space before them is its
// own text, so the name reads "Request (1 problem)"; a flex row, where the
// mark sits, doesn't draw it.
export function ProblemMark({ count }: { count: number }) {
  return (
    <>
      {" "}
      <CircleAlertIcon aria-hidden className="text-destructive" />
      <span className="sr-only">
        {count === 1 ? "(1 problem)" : `(${count} problems)`}
      </span>
    </>
  );
}

// Marked marks a tab whose part of the step has problems.
export function Marked({ where }: { where: (p: Place) => boolean }) {
  const count = useProblemCount(where);
  return count > 0 ? <ProblemMark count={count} /> : null;
}
