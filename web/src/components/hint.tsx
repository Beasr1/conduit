import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// Hint is what a field is for, in a line or two, behind an ⓘ beside it
// rather than under it (plan 13). It opens on hover, as an infotip, and on
// a click or Enter, so touch and keyboard users reach it too, which Base
// UI's tooltip wouldn't do. Escape closes it, and it stays open while the
// pointer is over it, as WCAG 1.4.13 asks. The button is 24 px, the floor
// for a target (2.5.8).
export function Hint({
  about,
  children,
}: {
  about: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        aria-label={`About ${about}`}
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
          />
        }
      >
        <InfoIcon aria-hidden />
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64 text-xs">
        {children}
      </PopoverContent>
    </Popover>
  );
}
