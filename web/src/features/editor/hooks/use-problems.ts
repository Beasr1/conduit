import { createContext, useContext } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  type Check,
  type Found,
  type Place,
  problemsIn,
  type StepField,
} from "@/features/editor/problems";
import { useEditor } from "@/features/editor/store";

// The editor's last check of the draft, and whether a newer one is on its
// way or failed. Outside an editor's check, nothing has problems.
export const CheckContext = createContext<Check | undefined>(undefined);
export const CheckingContext = createContext({
  checking: false,
  failed: false,
});

const none: Found[] = [];

// useProblems is the problems at the places where picks, in the draft as it
// is now. A component reading it redraws when they change, not on every
// edit.
export function useProblems(where: (p: Place) => boolean): Found[] {
  const check = useContext(CheckContext);
  return useEditor(
    useShallow((s) =>
      check ? problemsIn(check, s.draft).filter((f) => where(f.place)) : none,
    ),
  );
}

// useProblemCount is how many problems are at the places where picks.
export function useProblemCount(where: (p: Place) => boolean): number {
  const check = useContext(CheckContext);
  return useEditor((s) =>
    check ? problemsIn(check, s.draft).filter((f) => where(f.place)).length : 0,
  );
}

// atStep picks the places in one step: in the fields given, or anywhere in
// it.
export function atStep(index: number, ...fields: StepField[]) {
  return (p: Place) =>
    p.on === "step" &&
    p.index === index &&
    (fields.length === 0 ||
      (p.field !== undefined && fields.includes(p.field)));
}

// asErrors puts problems where FieldError takes a form's errors.
export function asErrors(found: Found[]): { message: string }[] {
  return found.map((f) => ({ message: f.message }));
}
