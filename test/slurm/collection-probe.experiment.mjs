import { expect, test } from "vitest";

// The one probe that proves the collection split: `vitest.experiment.config.ts` collects this file
// and `vitest.config.ts`, whose include is `**/*.test.{ts,mjs}`, cannot.
test("an experiment probe is collected only by the experiment config", () => {
  expect(import.meta.url.endsWith(".experiment.mjs")).toBe(true);
});
