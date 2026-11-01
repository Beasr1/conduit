import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useId } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, ApiError, call } from "@/lib/api";

const schema = z.object({
  token: z.string().trim().min(1, "Paste the API token."),
});
type Values = z.infer<typeof schema>;

// SignInForm trades the API token for the session cookie, then calls
// onSignedIn. The page keeps neither: the cookie is out of its reach. The
// sign-in page has it, and so does the editor, to sign in again over
// unsaved changes once a session ends.
export function SignInForm({ onSignedIn }: { onSignedIn: () => void }) {
  const id = useId();
  const signIn = useMutation({
    mutationFn: (token: string) =>
      call((signal) => api.POST("/v1/session", { body: { token }, signal })),
    // The form says what went wrong.
    meta: { quiet: true },
  });
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { token: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit({ token }: Values) {
    try {
      await signIn.mutateAsync(token);
      onSignedIn();
    } catch (err) {
      form.setError("token", {
        message:
          err instanceof ApiError && err.kind === "unauthorized"
            ? "That isn't the API token."
            : err instanceof Error
              ? err.message
              : "Couldn't sign in.",
      });
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Field data-invalid={!!errors.token}>
          <FieldLabel htmlFor={id}>API token</FieldLabel>
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            aria-invalid={!!errors.token}
            {...form.register("token")}
          />
          <FieldError errors={[errors.token]} />
        </Field>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
      </FieldGroup>
    </form>
  );
}
