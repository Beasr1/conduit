import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
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
import { useCreateWorkflow } from "@/features/workflows/hooks/use-workflows";
import { ApiError } from "@/lib/api";
import { fieldErrors } from "@/lib/problems";
import { routes } from "@/router";

// The server's rules, checked here only so a mistake shows at once; the
// server checks them again and decides.
const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give it a name.")
    .max(200, "A name is at most 200 characters."),
  slug: z
    .string()
    .regex(
      /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
      "1 to 64 lowercase letters, digits and hyphens, not starting or ending with a hyphen.",
    ),
});
type Values = z.infer<typeof schema>;

export function CreateWorkflowDialog() {
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string>();
  const navigate = useNavigate();
  const create = useCreateWorkflow();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", slug: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: Values) {
    setFormError(undefined);
    try {
      const created = await create.mutateAsync({
        ...values,
        definition: { nodes: [] },
      });
      setOpen(false);
      void navigate(routes.workflow(created.workflow.id));
    } catch (err) {
      showError(err);
    }
  }

  // The server's answer goes where it belongs: a taken slug to the slug, a
  // problem with a pointer to its field, anything else to the whole form.
  function showError(err: unknown) {
    if (!(err instanceof ApiError)) {
      setFormError("Something went wrong.");
      return;
    }
    if (err.status === 409) {
      form.setError("slug", { message: err.message });
      return;
    }
    const fields = ["name", "slug"] as const;
    const { byField, rest } = fieldErrors(err.problem, fields);
    for (const field of fields) {
      const message = byField[field];
      if (message) form.setError(field, { message });
    }
    if (rest.length > 0 || Object.keys(byField).length === 0)
      setFormError([err.message, ...rest].join(" "));
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
      <DialogTrigger render={<Button />}>New workflow</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>
            It starts empty. The slug is its address when published:
            /serve/&lt;slug&gt;.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="workflow-name">Name</FieldLabel>
              <Input
                id="workflow-name"
                aria-invalid={!!errors.name}
                {...form.register("name")}
              />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.slug}>
              <FieldLabel htmlFor="workflow-slug">Slug</FieldLabel>
              <Input
                id="workflow-slug"
                className="font-mono"
                aria-invalid={!!errors.slug}
                {...form.register("slug")}
              />
              <FieldError errors={[errors.slug]} />
            </Field>
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
