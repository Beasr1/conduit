import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateUpstream } from "@/features/upstreams/hooks/use-upstreams";
import { ApiError } from "@/lib/api";
import { routes } from "@/router";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

// The server's rules for a name, checked here so a mistake shows at once.
const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give it a name.")
    .max(200, "A name is at most 200 characters."),
  method: z.enum(METHODS),
  url: z.string().trim().min(1, "Add a URL."),
});
type Values = z.infer<typeof schema>;

// A placeholder that's a plain name, {{ user_id }}, is a parameter.
const PARAMETER = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/g;

// Where the server's problems with a new upstream go, by pointer.
const fieldOf: Record<string, keyof Values> = {
  "/name": "name",
  "/definition/request/method": "method",
  "/definition/request/url": "url",
};

// CreateUpstreamDialog makes an upstream from a name and the call it makes
// (plan 07), each name its URL reads in a placeholder a parameter; its page
// adds the rest: samples, responses, headers and a body.
export function CreateUpstreamDialog() {
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string>();
  const navigate = useNavigate();
  const create = useCreateUpstream();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", method: "GET", url: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit({ name, method, url }: Values) {
    setFormError(undefined);
    try {
      const names = [
        ...new Set([...url.matchAll(PARAMETER)].map((m) => m[1]!)),
      ];
      const made = await create.mutateAsync({
        name,
        definition: {
          ...(names.length > 0 && {
            parameters: names.map((n) => ({ name: n })),
          }),
          request: { method, url },
        },
      });
      setOpen(false);
      void navigate(routes.upstream(made.upstream.id));
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setFormError("Something went wrong.");
        return;
      }
      if (err.status === 409) {
        form.setError("name", {
          message: "An upstream already has that name.",
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
      <DialogTrigger render={<Button />}>New upstream</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New upstream</DialogTitle>
          <DialogDescription>
            An API steps call, saved once. Each name its URL reads, as{" "}
            <span className="font-mono">{"{{ user_id }}"}</span>, is a parameter
            a step gives it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="upstream-name">Name</FieldLabel>
              <Input
                id="upstream-name"
                placeholder="Users API"
                aria-invalid={!!errors.name}
                {...form.register("name")}
              />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.url}>
              <FieldLabel htmlFor="upstream-url">URL</FieldLabel>
              <div className="flex gap-2">
                <Controller
                  control={form.control}
                  name="method"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={(m) => m && field.onChange(m)}
                    >
                      <SelectTrigger aria-label="Method" className="font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {METHODS.map((m) => (
                          <SelectItem key={m} value={m} className="font-mono">
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <Input
                  id="upstream-url"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://api.example.com/v1/users/{{ user_id }}"
                  aria-invalid={!!errors.url}
                  {...form.register("url")}
                />
              </div>
              <FieldError errors={[errors.url, errors.method]} />
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
