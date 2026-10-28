import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useSignIn } from "@/features/session/hooks/use-session";
import { ApiError } from "@/lib/api";
import { safeFrom } from "@/router";

const schema = z.object({
  token: z.string().trim().min(1, "Paste the API token."),
});
type Values = z.infer<typeof schema>;

export function Component() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const signIn = useSignIn();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { token: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit({ token }: Values) {
    try {
      await signIn.mutateAsync(token);
      void navigate(safeFrom(params.get("from")), { replace: true });
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
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Conduit</CardTitle>
          <CardDescription>
            Paste the server&apos;s API token. This browser stays signed in for
            12 hours; the token itself isn&apos;t kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FieldGroup>
              <Field data-invalid={!!errors.token}>
                <FieldLabel htmlFor="token">API token</FieldLabel>
                <Input
                  id="token"
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
        </CardContent>
      </Card>
    </main>
  );
}
