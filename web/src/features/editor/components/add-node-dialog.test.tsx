import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { Editor } from "@/features/editor/components/editor";
import { specExample } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { renderAt } from "@/test/render";
// For its cleanup between tests, and to fail on any request the editor makes.
import "@/test/server";

shimReactFlow();

function typeId(value: string) {
  fireEvent.change(screen.getByLabelText("Id"), { target: { value } });
}

test("adds a node under the id it's given, checking the id as it's typed", async () => {
  renderAt(<Editor definition={specExample} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add HTTP node" }));

  typeId("Fetch");
  expect(await screen.findByText(/^A lowercase letter/)).toBeTruthy();
  typeId("user");
  expect(
    await screen.findByText("Another node already has this id."),
  ).toBeTruthy();

  typeId("notify");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(await screen.findByText("notify")).toBeTruthy();
  expect(screen.getByText("GET (no URL yet)")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
