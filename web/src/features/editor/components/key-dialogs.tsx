import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

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
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCreateKey,
  useRevokeKey,
  useRotateKey,
} from "@/features/editor/hooks/use-keys";
import type { components } from "@/gen/schema";
import { ApiError } from "@/lib/api";

type CallerKey = components["schemas"]["CallerKey"];
type Expiry = components["schemas"]["RotateKey"]["old_expires_in"];

// The dialogs of the Keys panel (plan 07). A key's value comes once, in the
// answer that made it, so each dialog that makes one shows it then, to copy,
// and forgets it once the dialog has closed, however it was closed: Done
// sets open itself, which onOpenChange doesn't hear. Over the editor, the
// dialogs carry nokey, as the canvas deletes what's picked on Delete or
// Backspace anywhere but in a text field.

// ShownOnce is a key just made, to copy before the dialog closes.
function ShownOnce({
  name,
  value,
  onDone,
}: {
  name: string;
  value: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<"copied" | "failed">();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="key-value">Key for {name}</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="key-value"
              readOnly
              value={value}
              className="font-mono"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button variant="outline" onClick={() => void copy()}>
              {copied === "copied" ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Copy it now: it isn&apos;t shown again.
          </p>
          {copied === "failed" && (
            <p role="alert" className="text-sm text-destructive">
              Couldn&apos;t copy it. Select it and copy it yourself.
            </p>
          )}
        </Field>
      </FieldGroup>
      <DialogFooter className="mt-4">
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}

const named = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give it a name: who calls with it.")
    .max(200, "A name is at most 200 characters."),
});
type Named = z.infer<typeof named>;

// NewKeyDialog makes a key for a caller, named for it.
export function NewKeyDialog({ workflow }: { workflow: string }) {
  const [open, setOpen] = useState(false);
  const [made, setMade] = useState<{ name: string; value: string }>();
  const [formError, setFormError] = useState<string>();
  const create = useCreateKey(workflow);
  const form = useForm<Named>({
    resolver: zodResolver(named),
    defaultValues: { name: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit({ name }: Named) {
    setFormError(undefined);
    try {
      const { key, value } = await create.mutateAsync(name);
      setMade({ name: key.name, value });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409)
        form.setError("name", {
          message: "An active key of this workflow has that name.",
        });
      else
        setFormError(
          err instanceof ApiError ? err.message : "Something went wrong.",
        );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(opened) => {
        if (opened) return;
        setMade(undefined);
        setFormError(undefined);
        form.reset();
      }}
    >
      <DialogTrigger render={<Button className="self-start" />}>
        New key
      </DialogTrigger>
      <DialogContent className="nokey sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New key</DialogTitle>
          <DialogDescription>
            One for each caller, so each can be rotated or revoked on its own.
          </DialogDescription>
        </DialogHeader>
        {made ? (
          <ShownOnce
            name={made.name}
            value={made.value}
            onDone={() => setOpen(false)}
          />
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FieldGroup>
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="key-name">Caller</FieldLabel>
                <Input
                  id="key-name"
                  autoComplete="off"
                  placeholder="CRM sync"
                  aria-invalid={!!errors.name}
                  {...form.register("name")}
                />
                <FieldError errors={[errors.name]} />
              </Field>
              {formError && (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}
            </FieldGroup>
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Making…" : "Make"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// expiries is how long a rotated key goes on working, in the API's words
// and the screen's.
const expiries: [Expiry, string][] = [
  ["now", "Now"],
  ["1h", "In an hour"],
  ["1d", "In a day"],
  ["7d", "In 7 days"],
];
const expiryLabel = (v: Expiry | null) =>
  expiries.find(([e]) => e === v)?.[1] ?? "Pick when";

// RotateKeyDialog gives a key's caller a new key, shown once, and the old
// key the expiry picked, so the caller can change over first. It opens as
// it's mounted, and onClosed is told once it has closed: the panel mounts it
// for one key, and not in the key's row, which a rotation moves or changes
// as the list is asked again, so the new key stays until it's copied.
export function RotateKeyDialog({
  workflow,
  callerKey: k,
  onClosed,
}: {
  workflow: string;
  callerKey: CallerKey;
  onClosed: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [expires, setExpires] = useState<Expiry | null>(null);
  const [made, setMade] = useState<string>();
  const rotate = useRotateKey(workflow, k.id);
  const failed = !rotate.isError
    ? undefined
    : rotate.error instanceof ApiError && rotate.error.status === 409
      ? "It was rotated or revoked already."
      : `Not rotated. ${rotate.error.message}`;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(opened) => {
        if (!opened) onClosed();
      }}
    >
      <DialogContent className="nokey sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rotate {k.name}</DialogTitle>
          <DialogDescription>
            Its caller gets a new key, and the old one,{" "}
            <span className="font-mono">{k.prefix}…</span>, stops when you pick.
          </DialogDescription>
        </DialogHeader>
        {made ? (
          <ShownOnce name={k.name} value={made} onDone={() => setOpen(false)} />
        ) : (
          <>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="key-expires">Old key stops</FieldLabel>
                <Select<Expiry | null>
                  value={expires}
                  onValueChange={(v) => setExpires(v)}
                >
                  <SelectTrigger id="key-expires" className="w-full">
                    <SelectValue>{expiryLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {expiries.map(([v, label]) => (
                      <SelectItem key={v} value={v}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {failed && (
                <p role="alert" className="text-sm text-destructive">
                  {failed}
                </p>
              )}
            </FieldGroup>
            <DialogFooter className="mt-4">
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button
                disabled={expires === null || rotate.isPending || !!failed}
                onClick={() =>
                  expires &&
                  rotate.mutate(expires, {
                    onSuccess: ({ value }) => setMade(value),
                  })
                }
              >
                {rotate.isPending ? "Rotating…" : "Rotate"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// RevokeKeyDialog stops a key at once, once asked again. Like
// RotateKeyDialog, it opens as it's mounted, and onClosed is told once it
// has closed.
export function RevokeKeyDialog({
  workflow,
  callerKey: k,
  onClosed,
}: {
  workflow: string;
  callerKey: CallerKey;
  onClosed: () => void;
}) {
  const [open, setOpen] = useState(true);
  const revoke = useRevokeKey(workflow, k.id);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(opened) => {
        if (!opened) onClosed();
      }}
    >
      <DialogContent className="nokey">
        <DialogHeader>
          <DialogTitle>Revoke {k.name}?</DialogTitle>
          <DialogDescription>
            Its key <span className="font-mono">{k.prefix}…</span> stops working
            at once, for good. It stays listed.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() =>
              revoke.mutate(undefined, { onSuccess: () => setOpen(false) })
            }
          >
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
