import { createContext, type ReactNode, useContext } from "react";

// What's archived opens read-only (plan 15): the editor around it says so
// through this, and what would change it leaves itself out or is disabled.
export const ReadOnly = createContext(false);

export const useReadOnly = () => useContext(ReadOnly);

// Fields disables every control inside it while read-only: a disabled
// fieldset does that for each button, input and select at once. A tab is no
// form control (TabsTrigger), so tabs go on opening what's on them to read,
// and nor is a link or a details element. A checkbox says so for itself
// (Checkbox), as Base UI's is a span.
export function Fields({ children }: { children: ReactNode }) {
  return (
    <fieldset disabled={useReadOnly()} className="contents">
      {children}
    </fieldset>
  );
}
