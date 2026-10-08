import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

// ponytail: recommended rules only, so CI catches real mistakes without forcing
// a rewrite of the existing JSX. Tighten per folder as new code lands.
export default [
  { ignores: ["dist/", "node_modules/", "playwright-report/", "test-results/", "supabase/functions/"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { react, "react-hooks": reactHooks },
    rules: {
      // Count JSX usage so components are not reported as unused.
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["api/**/*.js", "*.config.js", "tests/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Legacy single-file app: dead code here is reported as a warning, not removed in this change.
    files: ["Jabor.jsx", "SupportJaborSection.jsx"],
    rules: { "no-unused-vars": "warn" },
  },
  { files: ["public/sw.js"], languageOptions: { globals: { ...globals.serviceworker } } },
];
