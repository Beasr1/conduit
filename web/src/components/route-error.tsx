import { isRouteErrorResponse, Link, useRouteError } from "react-router";

import { Button, buttonVariants } from "@/components/ui/button";

// RouteError shows when a route can't: there's no page at the address, a
// page's code didn't load (as in a tab opened before a deploy, whose files
// are gone), or a page threw. home is the way out of a 404; it's passed in
// because this file can't import the router, which imports it.
export function RouteError({ home }: { home: string }) {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <h1 className="font-heading text-lg font-semibold">
          There's no page here
        </h1>
        <Link to={home} className={buttonVariants({ variant: "outline" })}>
          Go to workflows
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3 p-6">
      <h1 className="font-heading text-lg font-semibold">
        Something went wrong
      </h1>
      <p className="text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "The page couldn't load."}
      </p>
      {/* A reload fetches the app's current files, which is what a tab
          opened before a deploy needs. */}
      <Button variant="outline" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
