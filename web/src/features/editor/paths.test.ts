import { expect, test } from "vitest";

import { pathOf } from "@/features/editor/paths";

test.each<[string, string | number, string]>([
  ["", "input", "input"],
  ["nodes", "user", "nodes.user"],
  ["nodes.user.body", "email", "nodes.user.body.email"],
  ["nodes.orders.body", 0, "nodes.orders.body[0]"],
  ["nodes.orders.body[0]", "total", "nodes.orders.body[0].total"],
  // JSONata reads content-type as a subtraction, and the rest as something
  // other than a name, so they go in backticks.
  ["nodes.user.headers", "content-type", "nodes.user.headers.`content-type`"],
  ["nodes.user.body", "first name", "nodes.user.body.`first name`"],
  ["nodes.user.body", "2fa", "nodes.user.body.`2fa`"],
  ["nodes.user.body", "$id", "nodes.user.body.`$id`"],
  ["nodes.user.body", "and", "nodes.user.body.`and`"],
])("%j then %j is %j", (parent, key, path) => {
  expect(pathOf(parent, key)).toBe(path);
});
