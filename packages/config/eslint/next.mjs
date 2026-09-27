import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import base from "./base.mjs";

/**
 * Next.js apps. Accessibility rules are errors, not warnings:
 * WCAG 2.1 AA is a build gate (DISCOVERY.md §7.3), so a warning
 * nobody reads is the same as no rule at all.
 */
export default [
  ...base,
  {
    // Unscoped, so `next build` detects the plugin for every file it lints.
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "jsx-a11y": jsxA11y },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/anchor-is-valid": "error",
      "jsx-a11y/label-has-associated-control": "error",
      "jsx-a11y/no-autofocus": "error",
      // A positive tabIndex reorders the document against the reading order.
      "jsx-a11y/tabindex-no-positive": "error",
    },
  },
  {
    // Next's config API declares headers()/redirects() as returning a Promise;
    // `async` with no `await` is the idiomatic way to satisfy it.
    files: ["next.config.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
];
