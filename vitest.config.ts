import { configDefaults, defineConfig } from "vitest/config";

// The pinned-build qualification gate is left out of the routine suite on purpose. Measured on worker job
// 3744358, `vendor/pi/pinned-source-build.integration.test.mjs` took 198.9s of a 207.2s run on its own,
// because it prepares the locked upstream commit, builds the whole Pi cohort and installs a fresh consumer
// every time it runs. Excluding it keeps the ordinary feedback loop short. It is not removed and not
// weakened: it keeps its own config, `vitest.qualification.config.ts`, run by `npm run test:qualification`,
// and a change under `vendor/pi` still has to pass it.
const QUALIFICATION_GATE = "vendor/pi/pinned-source-build.integration.test.mjs";

export default defineConfig({
  test: {
    include: ["**/*.test.{ts,mjs}"],
    exclude: [...configDefaults.exclude, QUALIFICATION_GATE],
    globalSetup: ["./test/reap-test-processes.mjs"],
    // Real-process suites spawn daemons, workers and Pi children. On a shared box whose load swings
    // between 2 and 28 they need minutes, not the 5s default, and a timeout there reads as a product
    // failure rather than a busy machine. Measured: the same suites pass in 1s idle and exceed 5s above
    // roughly load 13.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
