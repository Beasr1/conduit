import { TriangleAlertIcon } from "lucide-react";

// sendsTheRun says whether JSONata text sends what the run read, rather
// than the fields a caller needs: $$ or nodes whole, or a step's headers,
// which can carry tokens and the upstream's own details. It's a plain text
// match, as the browser doesn't parse JSONata, so a string literal counts.
export function sendsTheRun(text: string | undefined): boolean {
  return (
    text !== undefined &&
    (/\$\$(?!\s*\.)/.test(text) ||
      /\bnodes\b(?!\s*\.)/.test(text) ||
      /\bnodes\.[a-z][a-z0-9_]*\.headers\b/.test(text))
  );
}

// WholeRunNote warns, without refusing, that what's written sends callers
// what the run read.
export function WholeRunNote({ text }: { text: string | undefined }) {
  if (!sendsTheRun(text)) return null;
  return (
    <p className="flex gap-1.5 text-sm text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
      <TriangleAlertIcon aria-hidden />
      This sends callers what the run read, upstream headers and all, which can
      carry secrets. Send the fields they need.
    </p>
  );
}
