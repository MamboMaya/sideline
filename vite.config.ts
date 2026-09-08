import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: {
    // Agent worktrees under .claude/ are full repo copies; without this
    // vitest runs their test files too (and biome.jsonc ignores them for
    // the same reason).
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
