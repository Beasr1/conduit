import { InUseTabs } from "@/components/in-use-tabs";
import { ConstantList } from "@/features/constants/components/constant-list";
import { CreateConstantDialog } from "@/features/constants/components/create-constant-dialog";

// The constants (plan 06): values every workflow reads by name, changed
// here for every run at once.
export function Component() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-heading text-xl font-semibold">Constants</h1>
        <CreateConstantDialog />
      </div>
      <InUseTabs
        of="Which constants"
        live={<ConstantList />}
        archived={<ConstantList archived />}
      />
    </div>
  );
}
