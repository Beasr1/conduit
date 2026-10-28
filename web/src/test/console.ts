import { afterEach, beforeEach, type MockInstance, vi } from "vitest";

// Any test that logs a console warning or error fails. They're how React,
// React Router and Base UI report misuse, and one that scrolls past in a
// passing run gets missed.
const levels = ["warn", "error"] as const;
let spies: { level: string; spy: MockInstance }[] = [];

beforeEach(() => {
  spies = levels.map((level) => ({
    level,
    spy: vi.spyOn(console, level).mockImplementation(() => {}),
  }));
});

afterEach(() => {
  const logged = spies.flatMap(({ level, spy }) =>
    spy.mock.calls.map((args) => `console.${level}: ${args.join(" ")}`),
  );
  for (const { spy } of spies) spy.mockRestore();
  if (logged.length > 0)
    throw new Error(`The test logged:\n${logged.join("\n")}`);
});
