import { Link } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArchiveDialog } from "@/components/archive-dialog";
import { ChangeConstantDialog } from "@/features/constants/components/change-constant-dialog";
import {
  useArchiveConstant,
  useConstantUsers,
  useRestoreConstant,
  useUndoConstant,
} from "@/features/constants/hooks/use-constants";
import { type Constant, useConstants } from "@/lib/constants";
import { routes } from "@/router";

const set = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

// ConstantList lists the constants by name (plan 06): a plain one's value,
// or that it's secret; what reads it; when it was last set; and what
// changes it. Archived ones are read and restored (plan 15).
export function ConstantList({ archived = false }: { archived?: boolean }) {
  const { data, isPending, isError } = useConstants(archived);

  if (isPending)
    return <p className="text-sm text-muted-foreground">Loading constants…</p>;
  if (isError)
    return <p className="text-sm text-destructive">Couldn't load constants.</p>;
  if (archived && data.constants.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nothing archived. Archive a constant nothing reads from its row.
      </p>
    );
  if (data.constants.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No constants yet. A constant is a value every workflow reads by its
        name, as <span className="font-mono">$const.crm_token</span>, changed
        here for every run at once: make one for an API key, an account number
        or a person&apos;s details.
      </p>
    );

  if (archived)
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Archived</TableHead>
            <TableHead>
              <span className="sr-only">Changes</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.constants.map((c) => (
            <ArchivedRow key={c.name} constant={c} />
          ))}
        </TableBody>
      </Table>
    );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Value</TableHead>
          <TableHead>Used by</TableHead>
          <TableHead>Set</TableHead>
          <TableHead>
            <span className="sr-only">Changes</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.constants.map((c) => (
          <ConstantRow key={c.name} constant={c} />
        ))}
      </TableBody>
    </Table>
  );
}

// Value is a plain constant's value, or that it's secret.
function Value({ constant: c }: { constant: Constant }) {
  return (
    <TableCell className="max-w-64 font-mono break-all whitespace-normal">
      {c.secret ? (
        <Badge variant="secondary" className="font-sans">
          Secret
        </Badge>
      ) : (
        c.value
      )}
    </TableCell>
  );
}

function ConstantRow({ constant: c }: { constant: Constant }) {
  const undo = useUndoConstant(c.name);
  const archive = useArchiveConstant(c.name);
  return (
    <TableRow>
      <TableCell className="font-mono">{c.name}</TableCell>
      <Value constant={c} />
      <TableCell className="whitespace-normal">
        <UsedBy name={c.name} />
      </TableCell>
      <TableCell>{set.format(new Date(c.updated_at))}</TableCell>
      <TableCell>
        <div className="flex justify-end gap-2">
          <ChangeConstantDialog constant={c} />
          {c.has_previous && (
            <Button
              variant="outline"
              size="sm"
              aria-label={`Undo ${c.name}`}
              disabled={undo.isPending}
              onClick={() => undo.mutate()}
            >
              Undo
            </Button>
          )}
          <ArchiveDialog
            name={c.name}
            size="sm"
            says="Nothing can read it any more. Its value stays sealed, and Restore brings it back."
            archive={archive}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

function ArchivedRow({ constant: c }: { constant: Constant }) {
  const restore = useRestoreConstant(c.name);
  return (
    <TableRow>
      <TableCell className="font-mono">{c.name}</TableCell>
      <Value constant={c} />
      <TableCell>
        {set.format(new Date(c.archived_at ?? c.updated_at))}
      </TableCell>
      <TableCell>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            aria-label={`Restore ${c.name}`}
            disabled={restore.isPending}
            onClick={() => restore.mutate()}
          >
            Restore
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// UsedBy names what reads a constant now, what archiving it is refused for,
// each a link to it: a workflow by each revision that does, its latest or
// its published one, and an upstream by its latest version.
function UsedBy({ name }: { name: string }) {
  const users = useConstantUsers(name);
  if (users.isError)
    return <span className="text-muted-foreground">Couldn&apos;t tell</span>;
  if (!users.data) return null;
  const { workflows, upstreams } = users.data;
  if (workflows.length + upstreams.length === 0)
    return <span className="text-muted-foreground">Nothing</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {workflows.map((w) => (
        <li key={`${w.workflow_id}@${w.revision}`}>
          <Link
            to={routes.workflow(w.workflow_id)}
            className="underline-offset-4 hover:underline"
          >
            {w.name}
          </Link>{" "}
          <span className="text-muted-foreground">· r{w.revision}</span>
        </li>
      ))}
      {upstreams.map((u) => (
        <li key={u.upstream_id}>
          <Link
            to={routes.upstream(u.upstream_id)}
            className="underline-offset-4 hover:underline"
          >
            {u.name}
          </Link>{" "}
          <span className="text-muted-foreground">· v{u.version}</span>
        </li>
      ))}
    </ul>
  );
}
