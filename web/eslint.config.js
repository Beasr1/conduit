import js from "@eslint/js";
import { plugin as shadcn } from "@shadcn/lint";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const tokenRules = [
  "shadcn/no-raw-colors",
  "shadcn/no-arbitrary-values",
  "shadcn/no-inline-styles",
  "shadcn/no-unknown-classes",
  "shadcn/require-static-classes",
];

export default defineConfig([
  globalIgnores(["dist", "src/gen"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: { globals: globals.browser },
  },
  {
    // Theme tokens only (web.md): no raw colours, arbitrary values or inline
    // styles, and no classes Tailwind can't generate or can't read.
    files: ["src/**/*.{ts,tsx}"],
    plugins: { shadcn },
    rules: Object.fromEntries(tokenRules.map((rule) => [rule, "error"])),
  },
  {
    // shadcn's generated components use arbitrary values of their own.
    files: ["src/components/ui/**"],
    rules: Object.fromEntries(tokenRules.map((rule) => [rule, "off"])),
  },
]);
