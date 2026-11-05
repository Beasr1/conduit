import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useSetConstant } from "@/features/constants/hooks/use-constants";
import { ApiError } from "@/lib/api";
import type { Constant } from "@/lib/constants";

const schema = z.object({
  value: z
    .string()
    .min(1, "Give it a value.")
    .max(4096, "A value is at most 4096 characters."),
  secret: z.boolean(),
});
type Values = z.infer<typeof schema>;

// ChangeConstantDialog changes a constant's value for every run from then
// on, keeping the one before for Undo (plan 06). A plain one starts from
// its value, and can be made secret, for good; a secret one starts empty,
// as its value is never shown.
export function ChangeConstantDialog({ constant: c }: { constant: Constant }) {
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string>();
  const change = useSetConstant(c.name);
  const start: Values = {
    value: c.secret ? "" : (c.value ?? ""),
    secret: false,
  };
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: start,
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: Values) {
    setFormError(undefined);
    try {
      await change.mutateAsync(values);
      setOpen(false);
    } catch (err) {
      const said =
        err instanceof ApiError
          ? err.problem?.errors?.find((e) => e.pointer === "/value")?.detail
          : undefined;
      if (said) form.setError("value", { message: said });
      else
        setFormError(
          err instanceof ApiError ? err.message : "Something went wrong.",
        );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) form.reset(start);
        else setFormError(undefined);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" aria-label={`Change ${c.name}`} />
        }
      >
        Change
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Change {c.name}</DialogTitle>
          <DialogDescription>
            Every run from then on reads the new value, with no Publish. Undo
            puts this one back.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.value}>
              <FieldLabel htmlFor="constant-new-value">
                {c.secret ? "New value" : "Value"}
              </FieldLabel>
              <Textarea
                id="constant-new-value"
                className="min-h-20 font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!errors.value}
                {...form.register("value")}
              />
              <FieldError errors={[errors.value]} />
            </Field>
            {!c.secret && (
              <Field orientation="horizontal">
                <Controller
                  control={form.control}
                  name="secret"
                  render={({ field }) => (
                    <Checkbox
                      id="constant-make-secret"
                      checked={field.value}
                      onCheckedChange={(on) => field.onChange(on)}
                    />
                  )}
                />
                <FieldContent>
                  <div className="flex items-center gap-1">
                    <FieldLabel htmlFor="constant-make-secret">
                      Make it secret
                    </FieldLabel>
                    <Hint about="Make it secret">
                      For good: its value is never shown again, and runs mask it
                      wherever they&apos;re kept or shown.
                    </Hint>
                  </div>
                </FieldContent>
              </Field>
            )}
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Changing…" : "Change"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
