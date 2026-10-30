import { useEffect, useState } from "react";

// How long the draft stands still before the server looks at it: once a
// pause, not once a key.
export const PAUSE_MS = 500;

// useStill is value as it was when it last stood still for ms: it follows
// value, a pause behind.
export function useStill<T>(value: T, ms: number): T {
  const [still, setStill] = useState(value);
  useEffect(() => {
    const wait = setTimeout(() => setStill(value), ms);
    return () => clearTimeout(wait);
  }, [value, ms]);
  return still;
}
