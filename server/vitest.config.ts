import { defineConfig } from "vitest/config";

// Some tests start servers through the API; the Steam query of a "running" fake server
// waits out its timeout (~1.5 s), so a few tests take several seconds on slow CI runners.
export default defineConfig({
  test: { testTimeout: 30_000 },
});
