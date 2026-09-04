import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // .tsx so Ink components can be rendered and asserted on.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
