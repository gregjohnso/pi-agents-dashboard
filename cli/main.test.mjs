import { expect, it, vi } from "vitest";

import { runCli } from "./main.mjs";

function capture() {
  const stdout = [];
  const stderr = [];
  return { stdout, stderr, io: { stdout: { write: (value) => { stdout.push(String(value)); } }, stderr: { write: (value) => { stderr.push(String(value)); } } } };
}

it("opens the list from empty argv and preserves startup cwd", async () => {
  const openApp = vi.fn(async () => {});
  const code = await runCli([], { cwd: "/repo", openApp, io: capture().io });
  expect(code).toBe(0);
  expect(openApp).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", piBin: undefined }));
});

it("accepts only exact --pi-bin standalone syntax", async () => {
  const openApp = vi.fn(async () => {});
  expect(await runCli(["--pi-bin", "/opt/pi"], { cwd: "/repo", openApp, io: capture().io })).toBe(0);
  expect(openApp).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", piBin: "/opt/pi" }));
  expect(await runCli(["--pi-bin"], { cwd: "/repo", openApp, io: capture().io })).toBe(2);
  expect(await runCli(["--pi-bin", "relative"], { cwd: "/repo", openApp, io: capture().io })).toBe(2);
});

it("prints standalone help without opening the app", async () => {
  const output = capture();
  const openApp = vi.fn(async () => {});
  expect(await runCli(["--help"], { openApp, io: output.io })).toBe(0);
  expect(output.stdout.join("")).toContain("With no arguments");
  expect(openApp).not.toHaveBeenCalled();
});

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

it("removes package registration and extension-host commands", async () => {
  for (const command of ["install", "uninstall", "doctor", "run"]) {
    expect(await runCli([command], { io: capture().io })).toBe(2);
  }
});
