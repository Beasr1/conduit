import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { Hint } from "@/components/hint";

afterEach(cleanup);

// Hover opens it too, which jsdom can't show: the browser check looks at
// that (plan 13).
test("a hint is a button named for its field, whose line a click shows and Escape puts away", async () => {
  render(<Hint about="URL">Absolute, http or https.</Hint>);
  const button = screen.getByRole("button", { name: "About URL" });
  expect(screen.queryByText("Absolute, http or https.")).toBeNull();
  fireEvent.click(button);
  expect(await screen.findByText("Absolute, http or https.")).toBeTruthy();
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await waitFor(() =>
    expect(screen.queryByText("Absolute, http or https.")).toBeNull(),
  );
});
