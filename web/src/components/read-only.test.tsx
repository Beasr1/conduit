import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";

import { Fields, ReadOnly } from "@/components/read-only";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

// Every part a panel holds, as its forms use them (plan 15): what Fields
// must stop, and the tabs it must not.
function Panel() {
  const [ticked, setTicked] = useState(false);
  const [pressed, setPressed] = useState(0);
  return (
    <Fields>
      <Tabs defaultValue="first">
        <TabsList aria-label="Blocks" activateOnFocus>
          <TabsTrigger value="first">First</TabsTrigger>
          <TabsTrigger value="second">Second</TabsTrigger>
        </TabsList>
        <TabsContent value="first">
          <Input aria-label="URL" defaultValue="https://example.com" />
          <Textarea aria-label="Body" defaultValue="{}" />
          <Button onClick={() => setPressed((n) => n + 1)}>Press</Button>
          <Checkbox
            aria-label="Required"
            checked={ticked}
            onCheckedChange={setTicked}
          />
          <Select defaultValue="GET">
            <SelectTrigger aria-label="Method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="POST">POST</SelectItem>
            </SelectContent>
          </Select>
          <details>
            <summary>What it reads</summary>
            <p>Nothing yet</p>
          </details>
          <a href="/upstreams/u-1">Open it</a>
          <p>
            Ticked {String(ticked)}, pressed {pressed}
          </p>
        </TabsContent>
        <TabsContent value="second">On the second tab</TabsContent>
      </Tabs>
    </Fields>
  );
}

afterEach(cleanup);

const disabled = (e: HTMLElement) => e.matches(":disabled");

test("read-only, each part is disabled, and the tabs and links still work", async () => {
  render(
    <ReadOnly value>
      <Panel />
    </ReadOnly>,
  );
  expect(disabled(screen.getByRole("textbox", { name: "URL" }))).toBe(true);
  expect(disabled(screen.getByRole("textbox", { name: "Body" }))).toBe(true);
  expect(disabled(screen.getByRole("button", { name: "Press" }))).toBe(true);
  const tick = screen.getByRole("checkbox", { name: "Required" });
  expect(tick.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(tick);
  fireEvent.keyDown(tick, { key: " " });
  expect(screen.getByText("Ticked false, pressed 0")).toBeTruthy();
  // A script's click reaches a disabled button, as a person's doesn't, so
  // that it can't be pressed or opened is the browser test's to show.
  expect(disabled(screen.getByRole("combobox", { name: "Method" }))).toBe(true);

  expect(screen.getByRole("link", { name: "Open it" })).toBeTruthy();
  expect(screen.getByText("What it reads").closest("details")).toBeTruthy();
  const second = screen.getByRole("tab", { name: "Second" });
  expect(disabled(second)).toBe(false);
  fireEvent.click(second);
  expect(await screen.findByText("On the second tab")).toBeTruthy();
  // By keyboard too, as a tab is no button now.
  const first = screen.getByRole("tab", { name: "First" });
  first.focus();
  fireEvent.keyDown(first, { key: "Enter" });
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "First" }).ariaSelected).toBe(
      "true",
    ),
  );
});

test("not read-only, the same parts work", () => {
  render(<Panel />);
  expect(disabled(screen.getByRole("textbox", { name: "URL" }))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Press" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Required" }));
  expect(screen.getByText("Ticked true, pressed 1")).toBeTruthy();
});
