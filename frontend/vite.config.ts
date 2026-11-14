/// <reference types="vitest/config" />
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wails from "@wailsio/runtime/plugins/vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [react(), tailwindcss(), ...(process.env.VITEST ? [] : [wails("./bindings")])],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Integration tests drive Radix and CodeMirror through user-event step by
    // step. With coverage on and every core busy (CI runners, parallel jobs)
    // a long one took 5-7 s, past Vitest's 5 s default, while asserting nothing
    // about speed. Races are fixed in the tests themselves; this is a budget.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/main.tsx",
        "src/components/ui/**", // vendored shadcn components
        "src/test/**",
        "src/lib/api.ts", // thin adapter over generated Wails bindings; mocked in tests
        "src/**/*.d.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
