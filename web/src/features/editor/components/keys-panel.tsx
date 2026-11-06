import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  NewKeyDialog,
  RevokeKeyDialog,
  RotateKeyDialog,
} from "@/features/editor/components/key-dialogs";
import { useKeys } from "@/features/editor/hooks/use-keys";
import type { components } from "@/gen/schema";

type CallerKey = components["schemas"]["CallerKey"];

const at = (t: string) => new Date(t).toLocaleString();

// which names a key by its caller and its first characters, as a rotated
// key and its new one share a name.
const which = (k: CallerKey) => `${k.name} (${k.prefix}…)`;

// stateOf says, in words, whether a key works and until when, and when it
// was last used.
function stateOf(k: CallerKey): string {
  const state = {
    active: `made ${at(k.created_at)}`,
    expiring: `rotated, works until ${at(k.expires_at ?? "")}`,
    expired: `rotated, stopped ${at(k.expires_at ?? "")}`,
    revoked: `revoked ${at(k.revoked_at ?? "")}`,
  }[k.status];
  const used = k.last_used_at
    ? `last used ${at(k.last_used_at)}`
    : "never used";
  return `${state} · ${used}`;
}

const works = (k: CallerKey) =>
  k.status === "active" || k.status === "expiring";

function KeyList({
  keys,
  onRotate,
  onRevoke,
}: {
  keys: CallerKey[];
  onRotate: (k: CallerKey) => void;
  onRevoke: (k: CallerKey) => void;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {keys.map((k) => (
        <li key={k.id} className="flex flex-col gap-1 rounded-md border p-2">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 font-medium wrap-break-word">
              {k.name}
            </span>
            <div className="flex shrink-0 gap-1">
              {k.status === "active" && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-haspopup="dialog"
                  aria-label={`Rotate ${which(k)}`}
                  onClick={() => onRotate(k)}
                >
                  Rotate
                </Button>
              )}
              {works(k) && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-haspopup="dialog"
                  aria-label={`Revoke ${which(k)}`}
                  onClick={() => onRevoke(k)}
                >
                  Revoke
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{k.prefix}…</span> · {stateOf(k)}
          </p>
        </li>
      ))}
    </ul>
  );
}

// KeysPanel is the workflow's caller keys (plan 07): those that work, each
// to rotate or revoke, and below, those stopped, kept for the record. It
// holds the dialog for the key being rotated or revoked, as the key's row
// moves or changes once the list is asked again.
export function KeysPanel({ workflow }: { workflow: string }) {
  const keys = useKeys(workflow);
  const [rotating, setRotating] = useState<CallerKey>();
  const [revoking, setRevoking] = useState<CallerKey>();
  const list = keys.data?.keys;
  const working = list?.filter(works) ?? [];
  const stopped = list?.filter((k) => !works(k)) ?? [];
  return (
    <>
      <p className="text-sm text-muted-foreground">
        A caller sends its key as{" "}
        <span className="font-mono break-all">
          Authorization: Bearer &lt;key&gt;
        </span>
        .
      </p>
      <NewKeyDialog workflow={workflow} />
      {list === undefined ? (
        keys.isError ? (
          <p className="text-sm text-destructive">Couldn&apos;t load them.</p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )
      ) : working.length > 0 ? (
        <KeyList keys={working} onRotate={setRotating} onRevoke={setRevoking} />
      ) : (
        <p className="text-sm text-muted-foreground">
          No key works yet. Make one for each caller.
        </p>
      )}
      {stopped.length > 0 && (
        <section aria-labelledby="keys-stopped" className="flex flex-col gap-2">
          <h3 id="keys-stopped" className="text-sm font-medium">
            Stopped
          </h3>
          <KeyList
            keys={stopped}
            onRotate={setRotating}
            onRevoke={setRevoking}
          />
        </section>
      )}
      {rotating && (
        <RotateKeyDialog
          key={rotating.id}
          workflow={workflow}
          callerKey={rotating}
          onClosed={() => setRotating(undefined)}
        />
      )}
      {revoking && (
        <RevokeKeyDialog
          key={revoking.id}
          workflow={workflow}
          callerKey={revoking}
          onClosed={() => setRevoking(undefined)}
        />
      )}
    </>
  );
}
