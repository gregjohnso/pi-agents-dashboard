import { expect, test } from "vitest";

// A real failing assertion, kept in an experiment probe so no default suite ever collects it. The
// driver's failure propagation is only checkable against a case that really fails.
test("this probe fails on purpose so the driver's failure propagation is checkable", () => {
  expect("deliberate-failure").toBe("passing");
});
