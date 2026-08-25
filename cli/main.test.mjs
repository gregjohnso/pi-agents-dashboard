import { expect, it } from "vitest";

import { runCli } from "./main.mjs";

function capture() {
  const stdout = [];
  const stderr = [];
  return { stdout, stderr, io: { stdout: { write: (value) => { stdout.push(String(value)); } }, stderr: { write: (value) => { stderr.push(String(value)); } } } };
}

it("prints exactly one JSON object and uses syntax exit code 2", async () => {
  const output = capture();
  const code = await runCli(["unknown", "--json"], { io: output.io });
  expect(code).toBe(2);
  expect(output.stdout).toHaveLength(1);
  expect(() => JSON.parse(output.stdout[0])).not.toThrow();
  expect(output.stderr).toEqual([]);
});

it("routes exact confirmed session commands without prefix resolution", async () => {
  const output = capture();
  const runSessionCommand = async (argv) => {
    expect(argv).toEqual(["delete", "full-session-id", "--revision", "3", "--yes"]);
    return { code: 0, result: { kind: "command", status: { stage: "COMPLETED" } } };
  };
  const code = await runCli(["session", "delete", "full-session-id", "--revision", "3", "--yes", "--json"], { io: output.io, runSessionCommand });
  expect(code).toBe(0);
  expect(JSON.parse(output.stdout[0])).toMatchObject({ ok: true, kind: "command" });
});

it("reports stock Pi as typed unsupported from doctor", async () => {
  const output = capture();
  const code = await runCli(["doctor", "--json"], {
    io: output.io,
    hostProbe: async () => ({ piVersion: "0.84.3", daemonOwnedStartup: false, nativeAttach: false, blockers: ["unsupported"] }),
  });
  expect(code).toBe(4);
  expect(JSON.parse(output.stdout[0])).toMatchObject({ ok: false, code: "UNSUPPORTED_HOST" });
});
