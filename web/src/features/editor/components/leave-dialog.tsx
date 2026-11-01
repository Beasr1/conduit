import { useQueryClient } from "@tanstack/react-query";
import type { Blocker } from "react-router";

import { SignInForm } from "@/components/sign-in-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { sessionEnded } from "@/router";

// LeaveDialog asks before the editor leaves with unsaved changes. When it's
// a 401 leaving for sign-in, as the session ended, it signs in again here
// instead, so the changes stay to be saved; then what was refused on the
// page is asked for again.
export function LeaveDialog({ blocker }: { blocker: Blocker }) {
  const queryClient = useQueryClient();
  const ended =
    blocker.state === "blocked" && sessionEnded(blocker.location.state);
  return (
    <Dialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
    >
      <DialogContent className="nokey">
        {ended ? (
          <>
            <DialogHeader>
              <DialogTitle>Sign in again</DialogTitle>
              <DialogDescription>
                Your session has ended, so nothing can be saved or run until you
                sign in. Your unsaved changes stay here.
              </DialogDescription>
            </DialogHeader>
            <SignInForm
              onSignedIn={() => {
                blocker.reset?.();
                void queryClient.refetchQueries({
                  type: "active",
                  predicate: (q) => q.state.status === "error",
                });
              }}
            />
            <DialogFooter>
              <Button variant="destructive" onClick={() => blocker.proceed?.()}>
                Leave without saving
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Leave without saving?</DialogTitle>
              <DialogDescription>
                Your unsaved changes here will be lost.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => blocker.reset?.()}>
                Stay
              </Button>
              <Button variant="destructive" onClick={() => blocker.proceed?.()}>
                Leave
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
