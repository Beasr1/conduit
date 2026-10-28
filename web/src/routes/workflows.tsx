import { CreateWorkflowDialog } from "@/features/workflows/components/create-workflow-dialog";
import { WorkflowList } from "@/features/workflows/components/workflow-list";

export function Component() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-heading text-xl font-semibold">Workflows</h1>
        <CreateWorkflowDialog />
      </div>
      <WorkflowList />
    </div>
  );
}
