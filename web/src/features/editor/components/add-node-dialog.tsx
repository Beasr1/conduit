import { zodResolver } from "@hookform/resolvers/zod";
import { useStoreApi } from "@xyflow/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

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
import {
  type Choice,
  NO_CHOICE,
  type Said,
  UpstreamChoice,
  useMakeStep,
} from "@/features/editor/components/upstream-choice";
import { addNode, ID_RULE, ID_TAKEN, NODE_ID } from "@/features/editor/edits";
import {
  freeSpot,
  NODE_HEIGHT,
  NODE_WIDTH,
  toFlow,
} from "@/features/editor/flow";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Node = components["schemas"]["Node"];

const labels = { http: "HTTP step", transform: "transform step" };

// AddNodeDialog asks for the new node's id, which expressions use to read
// its result, and puts the node in the middle of what the canvas shows, or
// below that, clear of the nodes already there. An HTTP step uses an
// upstream (plan 07): one from the library, at its latest version, or one
// made here from a call.
export function AddNodeDialog({ kind }: { kind: keyof typeof labels }) {
  const [open, setOpen] = useState(false);
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const canvas = useStoreApi();
  const makeStep = useMakeStep();
  const [choice, setChoice] = useState<Choice>(NO_CHOICE);
  const [said, setSaid] = useState<Said>({});
  // Checked as it's typed. Uniqueness reads the draft at the moment of
  // checking, so it's never against an old copy.
  const [schema] = useState(() =>
    z.object({
      id: z
        .string()
        .regex(NODE_ID, ID_RULE)
        .refine(
          (id) => !editor.getState().draft.nodes.some((n) => n.id === id),
          ID_TAKEN,
        ),
    }),
  );
  const form = useForm<{ id: string }>({
    resolver: zodResolver(schema),
    defaultValues: { id: "" },
    mode: "onChange",
  });
  const { errors, isSubmitting } = form.formState;
  const label = labels[kind];

  function reset() {
    form.reset();
    setChoice(NO_CHOICE);
    setSaid({});
  }

  async function onSubmit({ id }: { id: string }) {
    let node: Node = { id, kind: "transform", expr: "" };
    if (kind === "http") {
      const made = await makeStep(id, choice);
      if ("said" in made) {
        setSaid(made.said);
        return;
      }
      node = made.node;
    }
    const { width, height, transform } = canvas.getState();
    const [x, y, zoom] = transform;
    const middle = {
      x: (width / 2 - x) / zoom - NODE_WIDTH / 2,
      y: (height / 2 - y) / zoom - NODE_HEIGHT / 2,
    };
    const placed = toFlow(editor.getState().draft).nodes.map((n) => n.position);
    edit((d) => addNode(d, node, freeSpot(middle, placed)));
    setOpen(false);
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        Add {label}
      </DialogTrigger>
      {/* nokey: Delete or Backspace on its buttons would otherwise reach
          the canvas and delete what's selected behind the dialog. */}
      <DialogContent className="nokey">
        <DialogHeader>
          <DialogTitle>Add {label}</DialogTitle>
          <DialogDescription>
            In expressions, a step is{" "}
            <span className="font-mono">nodes.&lt;id&gt;</span>, so give it an
            id that says what it does.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.id}>
              <FieldLabel htmlFor={`new-${kind}-id`}>Id</FieldLabel>
              <Input
                id={`new-${kind}-id`}
                className="font-mono"
                placeholder="fetch_user"
                aria-invalid={!!errors.id}
                {...form.register("id")}
              />
              <FieldError errors={[errors.id]} />
            </Field>
            {kind === "http" && (
              <UpstreamChoice
                choice={choice}
                onChange={(next) => {
                  setChoice(next);
                  setSaid({});
                }}
                said={said}
              />
            )}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={isSubmitting}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
