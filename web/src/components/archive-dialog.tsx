import type { UseMutationResult } from "@tanstack/react-query";
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
import { ApiError } from "@/lib/api";

// ArchiveDialog archives what it names, once asked again, and says what
// happens. While something live uses it, the server refuses, and the
// dialog says what does (plan 15). Over the editor it carries nokey, as
// the canvas deletes what's picked on Delete or Backspace anywhere but in
// a text field.
export function ArchiveDialog<T>({
  name,
  says,
  archive,
  size,
  disabled,
}: {
  name: string;
  says: string;
  archive: UseMutationResult<T, Error, void>;
  size?: "sm";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const failed = !archive.isError
    ? undefined
    : archive.error instanceof ApiError && archive.error.problem?.detail
      ? archive.error.problem.detail
      : `Not archived. ${archive.error.message}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) archive.reset();
      }}
    >
      <DialogTrigger
        disabled={disabled}
        render={
          <Button
            variant="outline"
            size={size}
            aria-label={`Archive ${name}`}
          />
        }
      >
        Archive
      </DialogTrigger>
      <DialogContent className="nokey">
        <DialogHeader>
          <DialogTitle>Archive {name}?</DialogTitle>
          <DialogDescription>{says}</DialogDescription>
        </DialogHeader>
        {failed && <p className="text-sm text-destructive">{failed}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            disabled={archive.isPending || failed !== undefined}
            onClick={() =>
              archive.mutate(undefined, { onSuccess: () => setOpen(false) })
            }
          >
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
