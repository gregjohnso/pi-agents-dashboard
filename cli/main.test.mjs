import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { CLIENT_PROTOCOL } from "../shared/contracts.mjs";
import { startPreviousReleaseDaemon } from "../test/previous-release-daemon.mjs";
import { runCli } from "./main.mjs";

function capture() {
  const stdout = [];
  const stderr = [];
  return { stdout, stderr, io: { stdout: { write: (value) => { stdout.push(String(value)); } }, stderr: { write: (value) => { stderr.push(String(value)); } } } };
}

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function stateRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-agents-cli-main-"));
  roots.push(root);
  return root;
}

const EARLIER_RELEASE_LINE = `DAEMON_FROM_EARLIER_RELEASE: This daemon is from an earlier release and refused this client's protocol ${CLIENT_PROTOCOL} authentication. Run \`pi-agents daemon restart\` to restart it on this release; the restart stops no running session.`;

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
  // Both commands now exist, so the help advertises both and hides neither.
  for (const advertised of ["pi-agents agents", "pi-agents attach", "pi-agents logs [<full-session-id>]", "pi-agents stop|rm", "pi-agents respawn", "session cleanup", "session resolve-delivery"]) expect(help).toContain(advertised);
  for (const absent of ["session status", "session stop", "session delete"]) expect(help).not.toContain(absent);
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

// Operator-visible failure: the wait for a healthy endpoint runs inside runDaemonCommand and writes
// nowhere, so a start that hung left the operator's terminal blank until the command returned.
it("gives daemon start the operator's own error stream to report a slow wait on", async () => {
  const output = capture();
  const runDaemonCommand = async (/** @type {string} */ command, /** @type {any} */ options) => {
    expect(command).toBe("start");
    options.stderr.write("daemon start: waiting for a healthy endpoint (5s of 90s)\n");
    return { code: 0, result: { kind: "daemon_started", alreadyRunning: false } };
  };
  expect(await runCli(["daemon", "start", "--json"], { io: output.io, runDaemonCommand })).toBe(0);

  expect(output.stderr.join("")).toContain("waiting for a healthy endpoint");
  // The progress report is for a person and never joins the machine-readable answer.
  expect(output.stdout).toHaveLength(1);
  expect(JSON.parse(output.stdout[0])).toMatchObject({ ok: true, kind: "daemon_started" });
});

it.each([
  ["stop", ["stop", "full-session-id", "--revision", "3", "--yes"]],
  ["rm", ["rm", "full-session-id", "--revision", "3", "--yes"]],
  ["respawn", ["respawn", "full-session-id", "--revision", "3", "--yes"]],
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

// Operator-visible failure, 2026-08-31: against a daemon from the previous release these printed
// INVALID_DAEMON_AUTHENTICATION and AUTHENTICATION_FAILED, which name no cause and no action, one
// line under a state-root adoption notice the operator reasonably read as the error.
it.each([
  ["logs", ["logs", "exact-session-id"]],
  ["stop", ["stop", "exact-session-id", "--revision", "4", "--yes"]],
])("tells the operator that an earlier release refused %s, and names the command that fixes it", async (_name, argv) => {
  const root = await stateRoot();
  const daemon = await startPreviousReleaseDaemon(root);
  const output = capture();
  try {
    expect(await runCli(argv, { io: output.io, sessionOptions: { root } })).toBe(1);
  } finally {
    await daemon.close();
  }
  expect(output.stdout).toEqual([]);
  expect(output.stderr.join("")).toBe(`${EARLIER_RELEASE_LINE}\n`);
});

it("names the earlier release in the agents JSON the operator ran", async () => {
  const root = await stateRoot();
  const daemon = await startPreviousReleaseDaemon(root);
  const output = capture();
  try {
    expect(await runCli(["agents", "--json"], { io: output.io, sessionOptions: { root } })).toBe(1);
  } finally {
    await daemon.close();
  }
  expect(JSON.parse(output.stdout[0])).toEqual({ ok: false, code: "DAEMON_FROM_EARLIER_RELEASE", message: EARLIER_RELEASE_LINE.slice("DAEMON_FROM_EARLIER_RELEASE: ".length) });
});
