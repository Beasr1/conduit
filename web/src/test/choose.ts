import { fireEvent, screen } from "@testing-library/react";

// choose opens a select from the keyboard and presses an option. Base UI
// takes a click with no press before it only on the option highlighted.
export async function choose(label: string, option: string) {
  const select = screen.getByRole("combobox", { name: label });
  select.focus();
  fireEvent.keyDown(select, { key: "ArrowDown" });
  const choice = await screen.findByRole("option", { name: option });
  fireEvent.pointerDown(choice);
  fireEvent.click(choice);
}
