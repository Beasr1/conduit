import { useNavigate, useSearchParams } from "react-router";

import { SignInForm } from "@/components/sign-in-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { safeFrom } from "@/router";

export function Component() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Conduit</CardTitle>
          <CardDescription>
            Paste the server&apos;s API token. This browser stays signed in for
            up to 12 hours, or until it&apos;s left unused for 30 minutes; the
            token itself isn&apos;t kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm
            onSignedIn={() =>
              void navigate(safeFrom(params.get("from")), { replace: true })
            }
          />
        </CardContent>
      </Card>
    </main>
  );
}
