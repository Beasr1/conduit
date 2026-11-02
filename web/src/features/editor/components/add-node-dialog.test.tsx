import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { renderEditor } from "@/test/editor";
import { specExample } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
// For its cleanup between tests, and to fail on any request the editor makes.
import "@/test/server";

shimReactFlow();

function typeId(value: string) {
  fireEvent.change(screen.getByLabelText("Id"), { target: { value } });
}

test("adds a step under the id it's given, checking the id as it's typed", async () => {
  renderEditor(specExample);
  fireEvent.click(
    await screen.findByRole("button", { name: "Add transform step" }),
  );

  typeId("Fetch");
  expect(await screen.findByText(/^A lowercase letter/)).toBeTruthy();
  typeId("user");
  expect(
    await screen.findByText("Another step already has this id."),
  ).toBeTruthy();

  typeId("notify");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(await screen.findByText("notify")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

// An HTTP step uses an upstream (plan 07), so Add asks for one first.
test("an HTTP step needs an upstream", async () => {
  renderEditor(specExample);
  fireEvent.click(await screen.findByRole("button", { name: "Add HTTP step" }));
  typeId("notify");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(
    await screen.findByText("Pick an upstream, or make a new one."),
  ).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
});
