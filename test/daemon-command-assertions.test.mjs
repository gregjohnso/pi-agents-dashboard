import { expect, it } from "vitest";

import { describeDaemonCommandResult, expectDaemonCommand } from "./daemon-command-assertions.mjs";

const startFailure = {
  code: 1,
  error: {
    code: "DAEMON_START_FAILED",
    message: "Daemon did not become healthy before the startup deadline:\nDashboardConfigError: dashboard.json is invalid",
  },
};

it("names a failing daemon command's own reason on its first line", () => {
  const description = describeDaemonCommandResult("start", startFailure);

  expect(description.split("\n")[0]).toBe("daemon start returned code 1 (DAEMON_START_FAILED): Daemon did not become healthy before the startup deadline:");
  expect(description).toContain("DashboardConfigError: dashboard.json is invalid");
});

it("carries that reason into the assertion failure, which otherwise omits it entirely", () => {
  // `toMatchObject({ code: 0, ... })` prints "(3 matching properties omitted from actual)" and never
  // shows `error` at all, so a failed daemon start in an integration suite names no cause.
  let thrown;
  try {
    expectDaemonCommand("start", startFailure, { code: 0, result: { kind: "daemon_started" } });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeDefined();
  expect(String(thrown.message)).toContain("DAEMON_START_FAILED");
  expect(String(thrown.message)).toContain("Daemon did not become healthy before the startup deadline");
});

it("says so when a daemon command fails without an error field", () => {
  expect(describeDaemonCommandResult("stop", { code: 5 })).toBe("daemon stop returned code 5 and reported no error");
});

it("returns the matching result so a caller can keep reading it", () => {
  const started = { code: 0, result: { kind: "daemon_started", root: "/tmp/root" } };

  expect(expectDaemonCommand("start", started, { code: 0, result: { kind: "daemon_started" } })).toBe(started);
});
