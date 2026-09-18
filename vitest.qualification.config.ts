import { defineConfig } from "vitest/config";

// The expensive pinned-build qualification gate, on its own. It differs from `vitest.config.ts` in `include`
// and `exclude` only: the routine suite excludes this one file so the ordinary feedback loop stays short, and
// this config is the explicit opt-in that runs it. The case itself still refuses to run anywhere but a Slurm
// worker, so it is a build gate on a worker and a skip elsewhere — never a quietly dropped case.
export default defineConfig({
  test: {
    include: ["vendor/pi/pinned-source-build.integration.test.mjs"],
    globalSetup: ["./test/reap-test-processes.mjs"],
    // The same rationale as `vitest.config.ts`: real-process suites need minutes on a loaded box, not the
    // 5s default. This case also sets its own 660s timeout, which overrides this one.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
