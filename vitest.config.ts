import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.{ts,mjs}"],
    globalSetup: ["./test/reap-test-processes.mjs"],
    // Real-process suites spawn daemons, workers and Pi children. On a shared box whose load swings
    // between 2 and 28 they need minutes, not the 5s default, and a timeout there reads as a product
    // failure rather than a busy machine. Measured: the same suites pass in 1s idle and exceed 5s above
    // roughly load 13.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
