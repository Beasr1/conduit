import { useConstants } from "@/lib/constants";

// ConstantPicks offers each constant to an expression by its name, as
// $const.name (plan 06): a plain one beside its value, a secret one beside
// the word.
export function ConstantPicks({ onPick }: { onPick: (path: string) => void }) {
  const { data } = useConstants();
  if (!data?.constants.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs text-muted-foreground">Constants</h4>
      <ul className="flex flex-col gap-0.5 rounded-md bg-muted p-2 font-mono text-xs">
        {data.constants.map((c) => (
          <li key={c.name} className="flex items-baseline gap-1">
            <button
              type="button"
              aria-label={`Insert $const.${c.name}`}
              className="rounded-sm px-0.5 hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              onClick={() => onPick(`$const.${c.name}`)}
            >
              $const.{c.name}
            </button>
            <span className="break-all text-muted-foreground">
              {c.secret ? "secret" : JSON.stringify(c.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
