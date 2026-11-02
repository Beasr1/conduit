import { CreateUpstreamDialog } from "@/features/upstreams/components/create-upstream-dialog";
import { UpstreamList } from "@/features/upstreams/components/upstream-list";

// The upstream library (plan 07): the APIs steps call, each saved once.
export function Component() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-heading text-xl font-semibold">Upstreams</h1>
        <CreateUpstreamDialog />
      </div>
      <UpstreamList />
    </div>
  );
}
