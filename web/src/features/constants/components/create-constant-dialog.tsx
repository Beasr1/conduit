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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCreateConstant } from "@/features/constants/hooks/use-constants";
import { ApiError } from "@/lib/api";

// The server's rules for a constant, checked here so a mistake shows at once.
const schema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]{0,63}$/,
      "A lower-case letter, then lower-case letters, digits and underscores: 64 at most.",
    ),
  value: z
    .string()
    .min(1, "Give it a value.")
    .max(4096, "A value is at most 4096 characters."),
  secret: z.boolean(),
});
type Values = z.infer<typeof schema>;

// Where the server's problems with a new constant go, by pointer.
const fieldOf: Record<string, keyof Values> = {
  "/name": "name",
  "/value": "value",
};

// CreateConstantDialog makes a constant (plan 06): a name expressions read
// it by, its value, and whether it's secret.
export function CreateConstantDialog() {
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string>();
  const create = useCreateConstant();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", value: "", secret: false },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: Values) {
    setFormError(undefined);
    try {
      await create.mutateAsync(values);
      setOpen(false);
      form.reset();
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setFormError("Something went wrong.");
        return;
      }
      if (err.status === 409) {
        form.setError("name", {
          message: "A constant already has that name.",
        });
        return;
      }
      let placed = false;
      for (const e of err.problem?.errors ?? []) {
        const field = fieldOf[e.pointer];
        if (field) {
          form.setError(field, { message: e.detail });
          placed = true;
        }
      }
      if (!placed) setFormError(err.message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          form.reset();
          setFormError(undefined);
        }
      }}
    >
      <DialogTrigger render={<Button />}>New constant</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New constant</DialogTitle>
          <DialogDescription>
            A value every workflow reads by its name, as{" "}
            <span className="font-mono">$const.crm_token</span>, changed here
            for every run at once.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="constant-name">Name</FieldLabel>
              <Input
                id="constant-name"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="crm_token"
                aria-invalid={!!errors.name}
                {...form.register("name")}
              />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.value}>
              <FieldLabel htmlFor="constant-value">Value</FieldLabel>
              <Textarea
                id="constant-value"
                className="min-h-20 font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!errors.value}
                {...form.register("value")}
              />
              <FieldError errors={[errors.value]} />
            </Field>
            <Field orientation="horizontal">
              <Controller
                control={form.control}
                name="secret"
                render={({ field }) => (
                  <Checkbox
                    id="constant-secret"
                    checked={field.value}
                    onCheckedChange={(on) => field.onChange(on)}
                  />
                )}
              />
              <FieldContent>
                <div className="flex items-center gap-1">
                  <FieldLabel htmlFor="constant-secret">Secret</FieldLabel>
                  <Hint about="Secret">
                    Its value is never shown again, and runs mask it wherever
                    they&apos;re kept or shown.
                  </Hint>
                </div>
              </FieldContent>
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
      </DialogContent>
    </Dialog>
  );
}
