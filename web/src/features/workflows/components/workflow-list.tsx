import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useWorkflows } from "@/features/workflows/hooks/use-workflows";
import { routes } from "@/router";

const created = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function WorkflowList() {
  const {
    data,
    isPending,
    isError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useWorkflows();

  if (isPending)
    return <p className="text-sm text-muted-foreground">Loading workflows…</p>;
  if (isError)
    return <p className="text-sm text-destructive">Couldn't load workflows.</p>;

  const workflows = data.pages.flatMap((page) => page.workflows);
  if (workflows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No workflows yet. Create one to start.
      </p>
    );

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Revision</TableHead>
            <TableHead>Published</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workflows.map((w) => (
            <TableRow key={w.id}>
              <TableCell>
                <Link
                  to={routes.workflow(w.id)}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {w.name}
                </Link>
              </TableCell>
              <TableCell className="font-mono">{w.slug}</TableCell>
              <TableCell>{w.latest_revision}</TableCell>
              <TableCell>{w.published_revision ?? "—"}</TableCell>
              <TableCell>{created.format(new Date(w.created_at))}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      )}
    </div>
  );
}
