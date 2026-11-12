import type { ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// InUseTabs is a list of what's in use, with what's archived on a tab
// beside it (plan 15). The archived list is fetched once its tab opens.
export function InUseTabs({
  of,
  live,
  archived,
}: {
  of: string;
  live: ReactNode;
  archived: ReactNode;
}) {
  return (
    <Tabs defaultValue="live">
      <TabsList aria-label={of} activateOnFocus>
        <TabsTrigger value="live">In use</TabsTrigger>
        <TabsTrigger value="archived">Archived</TabsTrigger>
      </TabsList>
      <TabsContent value="live">{live}</TabsContent>
      <TabsContent value="archived">{archived}</TabsContent>
    </Tabs>
  );
}
