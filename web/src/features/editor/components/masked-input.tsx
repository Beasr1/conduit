import { useMemo } from "react";

import { Hint } from "@/components/hint";
import { MaskedFields } from "@/features/editor/components/masks";
import { setField } from "@/features/editor/edits";
import { useProblems } from "@/features/editor/hooks/use-problems";
import { fieldsIn } from "@/features/editor/masks";
import { useEditor } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type MaskedField = components["schemas"]["MaskedField"];

const UNMASKED: MaskedField[] = [];

// MaskedInput lists the fields of the run's input whose values are kept
// masked wherever a run keeps them (plan 17), offering those the sample
// input has. A served run masks by the published revision's.
export function MaskedInput() {
  const masked = useEditor((s) => s.draft.masked_input ?? UNMASKED);
  const sample = useEditor((s) => s.draft.sample_input);
  const edit = useEditor((s) => s.edit);
  const problems = useProblems(
    (p) => p.on === "settings" && p.field === "masked_input",
  );
  const offered = useMemo(() => fieldsIn(sample), [sample]);
  return (
    <section
      aria-label="Masked input fields"
      className="flex flex-col gap-2 text-sm"
    >
      <div className="flex items-center gap-1">
        <h3 className="font-medium">Masked input fields</h3>
        <Hint about="Masked input fields">
          Fields of the run&apos;s input kept as stars wherever a run keeps
          them. The run and its caller get them as they are.
        </Hint>
      </div>
      <MaskedFields
        id="workflow-masked-input"
        fields={masked}
        offered={offered}
        problems={(k) =>
          problems
            .filter(
              (f) =>
                f.place.on === "settings" &&
                (f.place.index === k ||
                  (k === 0 && f.place.index === undefined)),
            )
            .map((f) => f.message)
        }
        onChange={(next) =>
          edit((d) =>
            setField(d, "masked_input", next.length > 0 ? next : undefined),
          )
        }
      />
    </section>
  );
}
