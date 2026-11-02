import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { updateNode } from "@/features/editor/edits";
import {
  asErrors,
  atStep,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import { useEditor, useEditorStore } from "@/features/editor/store";
import { asUpstream, pin, versionKey } from "@/features/editor/upstreams";
import { useCreateUpstream } from "@/features/upstreams/hooks/use-upstreams";
import { ApiError } from "@/lib/api";

// SaveAsUpstream moves a step's own request into the library (plan 07):
// each placeholder becomes a parameter, which the step gives what it read,
// and the step then uses the new upstream's first version. Publish takes
// only steps that use one, so the problem saying so shows above it.
export function SaveAsUpstream({ index }: { index: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const addVersion = useEditor((s) => s.addVersion);
  const create = useCreateUpstream();
  const problems = useProblems(atStep(index, "request"));

  async function save() {
    const node = editor.getState().draft.nodes[index];
    if (!node) return;
    if (name.trim() === "") {
      setError("Give it a name.");
      return;
    }
    const { upstream, with: given } = asUpstream(node);
    try {
      const made = await create.mutateAsync({
        name: name.trim(),
        definition: upstream,
      });
      const uses = { upstream: made.upstream.id, version: made.version };
      addVersion(versionKey(uses), made.definition);
      edit((d) =>
        updateNode(d, index, (n) =>
          pin({ ...n, with: given }, uses, made.definition),
        ),
      );
      setOpen(false);
      setName("");
      setError(undefined);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "An upstream already has that name."
          : err instanceof ApiError && err.status === 422
            ? "The step's request has problems. Fix them, then save it as an upstream."
            : "Couldn't save it. Try again.",
      );
    }
  }

  return (
    <>
      <FieldError errors={asErrors(problems)} />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(undefined);
        }}
      >
        <DialogTrigger
          render={
            <Button
              id="step-save-as-upstream"
              variant="ghost"
              size="sm"
              className="self-start"
            />
          }
        >
          Save as upstream
        </DialogTrigger>
        {/* nokey: Delete or Backspace on its buttons would otherwise reach the
          canvas. */}
        <DialogContent className="nokey">
          <DialogHeader>
            <DialogTitle>Save as upstream</DialogTitle>
            <DialogDescription>
              Its request and responses go to the library, each placeholder a
              parameter, and this step then uses it.
            </DialogDescription>
          </DialogHeader>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <FieldGroup>
              <Field data-invalid={error !== undefined}>
                <FieldLabel htmlFor="new-upstream-name">Name</FieldLabel>
                <Input
                  id="new-upstream-name"
                  placeholder="Users API"
                  value={name}
                  aria-invalid={error !== undefined}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(undefined);
                  }}
                />
                {error && <FieldError>{error}</FieldError>}
              </Field>
            </FieldGroup>
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={create.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
