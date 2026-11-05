import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useDeleteConstant } from "@/features/constants/hooks/use-constants";
import { ApiError } from "@/lib/api";
import type { Constant } from "@/lib/constants";

// DeleteConstantDialog deletes a constant, once asked again. While a saved
// revision or an upstream version reads it, the server refuses, and the
// dialog says what does (plan 06).
export function DeleteConstantDialog({ constant: c }: { constant: Constant }) {
  const [open, setOpen] = useState(false);
  const del = useDeleteConstant(c.name);
  const failed = !del.isError
    ? undefined
    : del.error instanceof ApiError && del.error.problem?.detail
      ? del.error.problem.detail
      : `Not deleted. ${del.error.message}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) del.reset();
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" aria-label={`Delete ${c.name}`} />
        }
      >
        Delete
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {c.name}?</DialogTitle>
          <DialogDescription>
            It goes for good, with the value before it.
          </DialogDescription>
        </DialogHeader>
        {failed && <p className="text-sm text-destructive">{failed}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            disabled={del.isPending || failed !== undefined}
            onClick={() =>
              del.mutate(undefined, { onSuccess: () => setOpen(false) })
            }
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
