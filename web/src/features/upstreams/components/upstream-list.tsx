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
import { useUpstreams } from "@/features/upstreams/hooks/use-upstreams";
import { routes } from "@/router";

const created = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

// UpstreamList lists the library, newest first, a page at a time.
export function UpstreamList() {
  const {
    data,
    isPending,
    isError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useUpstreams();

  if (isPending)
    return <p className="text-sm text-muted-foreground">Loading upstreams…</p>;
  if (isError)
    return <p className="text-sm text-destructive">Couldn't load upstreams.</p>;

  const upstreams = data.pages.flatMap((page) => page.upstreams);
  if (upstreams.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No upstreams yet. Make one, or save a step&apos;s request as one in the
        editor.
      </p>
    );

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {upstreams.map((u) => (
            <TableRow key={u.id}>
              <TableCell>
                <Link
                  to={routes.upstream(u.id)}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {u.name}
                </Link>
              </TableCell>
              <TableCell>{u.latest_version}</TableCell>
              <TableCell>{created.format(new Date(u.created_at))}</TableCell>
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
