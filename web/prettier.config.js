// Tailwind classes in the order Tailwind applies them. The plugin reads the
// theme from the stylesheet, and sorts inside cn() and cva() calls too.
export default {
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindStylesheet: "./src/index.css",
  tailwindFunctions: ["cn", "cva"],
};
