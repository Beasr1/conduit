import { beforeEach } from "vitest";

import { markTourSeen } from "@/features/editor/components/tour";

// The tour opens on its own in a browser that hasn't seen it (plan 13), over
// whatever a test is doing, so tests start with it seen. tour.test.tsx
// clears it to see it open.
beforeEach(() => {
  markTourSeen();
});
