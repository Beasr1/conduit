import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { renderEditor } from "@/test/editor";
import { specExample } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
// For its cleanup between tests, and to fail on any request the editor makes.
import "@/test/server";

shimReactFlow();

// The stops of the tour over the Spec example, in order.
const stops = [
  "The canvas",
  "A step's request",
  "Its responses",
  "Connecting",
  "The response",
];

test("the tour waits for Tour in the toolbar, and Skip puts it away", async () => {
  renderEditor(specExample);
  await screen.findByTestId("rf__node-crm");
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Tour" }));
  const first = await screen.findByRole("dialog", { name: "The canvas" });
  expect(within(first).getByText("1 of 5")).toBeTruthy();
  expect(within(first).queryByRole("button", { name: "Back" })).toBeNull();
  fireEvent.click(within(first).getByRole("button", { name: "Skip" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("Tour in the toolbar goes through every stop, back and on, and Done ends it", async () => {
  renderEditor(specExample);
  fireEvent.click(await screen.findByRole("button", { name: "Tour" }));
  for (const [k, title] of stops.entries()) {
    const stop = await screen.findByRole("dialog", { name: title });
    expect(within(stop).getByText(`${k + 1} of ${stops.length}`)).toBeTruthy();
    if (k < stops.length - 1)
      fireEvent.click(within(stop).getByRole("button", { name: "Next" }));
  }
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "The response" })).getByRole(
      "button",
      { name: "Back" },
    ),
  );
  const back = await screen.findByRole("dialog", { name: "Connecting" });
  fireEvent.click(within(back).getByRole("button", { name: "Next" }));
  const last = await screen.findByRole("dialog", { name: "The response" });
  // It says how a run picks among the answers.
  expect(
    within(last).getByText(/the first one reached, top to bottom/),
  ).toBeTruthy();
  expect(within(last).queryByRole("button", { name: "Next" })).toBeNull();
  fireEvent.click(within(last).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Opened again, it starts afresh, not at the stop it was left on.
  fireEvent.click(screen.getByRole("button", { name: "Tour" }));
  expect(screen.queryByRole("dialog", { name: "The response" })).toBeNull();
  expect(
    within(await screen.findByRole("dialog", { name: "The canvas" })).getByText(
      "1 of 5",
    ),
  ).toBeTruthy();
});

test("a stop whose part isn't on the canvas is skipped, and Escape ends the tour", async () => {
  renderEditor({ nodes: [] });
  fireEvent.click(await screen.findByRole("button", { name: "Tour" }));
  const first = await screen.findByRole("dialog", { name: "The canvas" });
  expect(within(first).getByText("1 of 2")).toBeTruthy();
  fireEvent.click(within(first).getByRole("button", { name: "Next" }));
  const last = await screen.findByRole("dialog", { name: "The response" });
  expect(within(last).getByText("2 of 2")).toBeTruthy();
  fireEvent.keyDown(last, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
