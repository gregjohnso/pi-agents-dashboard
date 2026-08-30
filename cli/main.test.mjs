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

it("opens the list from the agents verb", async () => {
  const openApp = vi.fn(async () => {});
  const code = await runCli(["agents"], { cwd: "/repo", openApp, io: capture().io });
  expect(code).toBe(0);
  expect(openApp).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
});

it("prints agents rows for --json without opening the app", async () => {
  const output = capture();
  const openApp = vi.fn(async () => {});
  const runAgentsCommand = vi.fn(async () => ({ code: 0, result: { kind: "agents", sessions: [{ sessionId: "exact-session-id", revision: 4 }] } }));
  expect(await runCli(["agents", "--json"], { openApp, runAgentsCommand, io: output.io })).toBe(0);
  expect(openApp).not.toHaveBeenCalled();
  expect(JSON.parse(output.stdout[0])).toMatchObject({ ok: true, kind: "agents", sessions: [{ sessionId: "exact-session-id" }] });
});

it("routes attach to one exact session and rejects other attach grammar", async () => {
  const attachSession = vi.fn(async () => ({ code: 0, result: { kind: "detached", sessionId: "exact-session-id" } }));
  expect(await runCli(["attach", "exact-session-id"], { attachSession, io: capture().io })).toBe(0);
  expect(attachSession).toHaveBeenCalledWith("exact-session-id", undefined);
  expect(await runCli(["attach"], { attachSession, io: capture().io })).toBe(2);
  expect(await runCli(["attach", "a", "b"], { attachSession, io: capture().io })).toBe(2);
  expect(attachSession).toHaveBeenCalledTimes(1);
});

it("prints standalone help without opening the app", async () => {
  const output = capture();
  const openApp = vi.fn(async () => {});
  expect(await runCli(["--help"], { openApp, io: output.io })).toBe(0);
  const help = output.stdout.join("");
  expect(help).toContain("With no arguments");
  for (const advertised of ["pi-agents agents", "pi-agents attach", "pi-agents logs [<full-session-id>]", "pi-agents stop|rm", "session cleanup", "session resolve-delivery"]) expect(help).toContain(advertised);
  // Commit 5.4 adds respawn; advertising it before it answers would report a bug.
  for (const absent of ["respawn", "session status", "session stop", "session delete"]) expect(help).not.toContain(absent);
  expect(openApp).not.toHaveBeenCalled();
});

it("routes logs with and without one exact session ID", async () => {
  const received = [];
  const runLogsCommand = vi.fn(async (sessionId) => {
    received.push(sessionId);
    return { code: 0, result: { kind: "logs", sources: [], text: "" } };
  });
  expect(await runCli(["logs"], { runLogsCommand, io: capture().io })).toBe(0);
  expect(await runCli(["logs", "exact-session-id"], { runLogsCommand, io: capture().io })).toBe(0);
  expect(received).toEqual([undefined, "exact-session-id"]);
  expect(await runCli(["logs", "exact-session-id", "extra"], { runLogsCommand, io: capture().io })).toBe(2);
  expect(runLogsCommand).toHaveBeenCalledTimes(2);
});

it("writes log text unwrapped and keeps --json to one object", async () => {
  const path = "/state/daemon/startup.log";
  const text = `==> ${path} <==\nDashboardConfigError\n`;
  const runLogsCommand = async () => ({ code: 0, result: { kind: "logs", sources: [{ path, bytes: 21, truncated: false }], text } });
  const plain = capture();
  expect(await runCli(["logs"], { runLogsCommand, io: plain.io })).toBe(0);
  expect(plain.stdout.join("")).toBe(text);
  const structured = capture();
  expect(await runCli(["logs", "--json"], { runLogsCommand, io: structured.io })).toBe(0);
  expect(structured.stdout).toHaveLength(1);
  expect(JSON.parse(structured.stdout[0])).toMatchObject({ ok: true, kind: "logs", sources: [{ path }], text });
});

it("prints exactly one JSON object and uses syntax exit code 2", async () => {
  const output = capture();
  const code = await runCli(["unknown", "--json"], { io: output.io });
  expect(code).toBe(2);
  expect(output.stdout).toHaveLength(1);
  expect(() => JSON.parse(output.stdout[0])).not.toThrow();
  expect(output.stderr).toEqual([]);
});

it.each([
  ["stop", ["stop", "full-session-id", "--revision", "3", "--yes"]],
  ["rm", ["rm", "full-session-id", "--revision", "3", "--yes"]],
])("routes the top-level %s verb without prefix resolution", async (_name, argv) => {
  const output = capture();
  const runSessionCommand = async (received) => {
    expect(received).toEqual(argv);
    return { code: 0, result: { kind: "command", status: { stage: "COMPLETED" } } };
  };
  const code = await runCli([...argv, "--json"], { io: output.io, runSessionCommand });
  expect(code).toBe(0);
  expect(JSON.parse(output.stdout[0])).toMatchObject({ ok: true, kind: "command" });
});

it.each([
  ["status", ["session", "status", "full-session-id"]],
  ["stop", ["session", "stop", "full-session-id", "--revision", "3", "--yes"]],
  ["delete", ["session", "delete", "full-session-id", "--revision", "3", "--yes"]],
])("rejects the retired session %s form as ordinary syntax", async (_name, argv) => {
  const runSessionCommand = vi.fn(async () => ({ code: 0, result: { kind: "command", status: { stage: "COMPLETED" } } }));
  expect(await runCli(argv, { io: capture().io, runSessionCommand })).toBe(2);
  expect(runSessionCommand).not.toHaveBeenCalled();
});

it.each([
  ["cleanup", ["cleanup", "full-session-id", "--revision", "3", "--yes"]],
  ["resolve-delivery", ["resolve-delivery", "full-client-id", "full-request-id", "abandon", "--yes"]],
])("keeps recovery command %s under the session namespace", async (_name, argv) => {
  const runSessionCommand = vi.fn(async () => ({ code: 0, result: { kind: "command", status: { stage: "COMPLETED" } } }));
  expect(await runCli(["session", ...argv], { io: capture().io, runSessionCommand })).toBe(0);
  expect(runSessionCommand).toHaveBeenCalledWith(argv, undefined);
});
