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
import { addNode, NODE_ID } from "@/features/editor/edits";
import { NODE_HEIGHT, NODE_WIDTH } from "@/features/editor/flow";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Node = components["schemas"]["Node"];

const kinds = {
  http: {
    label: "HTTP node",
    fresh: (id: string): Node => ({
      id,
      kind: "http",
      request: { method: "GET", url: "" },
    }),
  },
  transform: {
    label: "transform node",
    fresh: (id: string): Node => ({ id, kind: "transform", expr: "" }),
  },
};

// AddNodeDialog asks for the new node's id, which expressions use to read
// its result, and puts the node in the middle of what the canvas shows.
export function AddNodeDialog({ kind }: { kind: keyof typeof kinds }) {
  const [open, setOpen] = useState(false);
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const canvas = useStoreApi();
  // Checked as it's typed. Uniqueness reads the draft at the moment of
  // checking, so it's never against an old copy.
  const [schema] = useState(() =>
    z.object({
      id: z
        .string()
        .regex(
          NODE_ID,
          "A lowercase letter, then up to 63 lowercase letters, digits and underscores.",
        )
        .refine(
          (id) => !editor.getState().draft.nodes.some((n) => n.id === id),
          "Another node already has this id.",
        ),
    }),
  );
  const form = useForm<{ id: string }>({
    resolver: zodResolver(schema),
    defaultValues: { id: "" },
    mode: "onChange",
  });
  const { errors } = form.formState;
  const label = kinds[kind].label;

  function onSubmit({ id }: { id: string }) {
    const { width, height, transform } = canvas.getState();
    const [x, y, zoom] = transform;
    const middle = {
      x: (width / 2 - x) / zoom - NODE_WIDTH / 2,
      y: (height / 2 - y) / zoom - NODE_HEIGHT / 2,
    };
    edit((d) => addNode(d, kinds[kind].fresh(id), middle));
    setOpen(false);
    form.reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) form.reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        Add {label}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {label}</DialogTitle>
          <DialogDescription>
            Expressions read its result as nodes.&lt;id&gt;, so give it an id
            that says what it does.
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
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="submit">Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
