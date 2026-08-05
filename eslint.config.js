// Flat config: typescript-eslint recommended + the react-hooks rules the
// codebase's stable-identity patterns are written against. Every
// eslint-disable in src/ must carry a justifying comment; unused disables
// are errors so stale ones can't linger.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", ".previews/", "node_modules/"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    // The two classic hooks rules only. The plugin's v7 "recommended" set
    // adds React-Compiler adoption rules (set-state-in-effect,
    // refs-during-render) that forbid patterns this codebase uses
    // deliberately and documents in place — e.g. the latest-ref mirror in
    // useKeyboard, straight from the React docs. Revisit if the app ever
    // adopts the compiler.
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
);
