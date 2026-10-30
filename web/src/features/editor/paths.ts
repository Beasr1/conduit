// A name JSONata reads as a field name as it stands. Anything else, such as
// content-type, which it would read as a subtraction, goes in backticks.
const plain = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Words JSONata keeps for itself, which can't stand as a field name.
const reserved = new Set([
  "and",
  "or",
  "in",
  "true",
  "false",
  "null",
  "function",
]);

// pathOf is the JSONata path to key below parent, a path itself, or the
// document itself when parent is "": a field by its name, an item of an
// array by its place.
export function pathOf(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  const name = plain.test(key) && !reserved.has(key) ? key : `\`${key}\``;
  return parent === "" ? name : `${parent}.${name}`;
}
