import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": path.join(__dirname, "src") } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    // Form tests type character by character; generous headroom for slow CI runners.
    testTimeout: 20_000,
    // The browser client's base URL; MSW handlers in src/test/server.ts match it.
    env: { NEXT_PUBLIC_API_URL: "http://localhost:8000" },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "html"],
      // Logic-bearing client code only. Next route files (src/app/**) — server
      // components, pages, layouts — are exercised by the Playwright E2E suite.
      include: ["src/components/**", "src/lib/**", "src/hooks/**"],
      exclude: [
        "src/components/ui/**", // copied shadcn primitives, not our code
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/app/**",
        // Server-only (next/headers): covered by Playwright E2E.
        "src/lib/api-server.ts",
      ],
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 70 },
    },
  },
});
