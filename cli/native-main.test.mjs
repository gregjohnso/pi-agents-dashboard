import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it, vi } from "vitest";

import { main } from "../bin/pi-agents.mjs";

const execFileAsync = promisify(execFile);
const PUBLIC_ENTRY = new URL("../bin/pi-agents.mjs", import.meta.url);
const roots = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function privateParent() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agents-native-cli-"));
  roots.push(root);
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(state, { recursive: true })]);
  return { root, home, state };
}

function capture() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    streams: {
      stdout: { write: (value) => stdout.push(String(value)) },
      stderr: { write: (value) => stderr.push(String(value)) },
    },
  };
}

it("dispatches bare public argv to the native manager with real, caller-scoped defaults", async () => {
  const output = capture();
  const openManager = vi.fn(async () => {});

  expect(await main([], {
    ...output.streams,
    openManager,
    cwd: "/private/project",
    homeDir: "/private/parent-home",
    uid: 1234,
  })).toBe(0);

  expect(openManager).toHaveBeenCalledOnce();
  expect(openManager).toHaveBeenCalledWith(expect.objectContaining({
    mode: "real",
    projectCwd: "/private/project",
    stateHome: "/private/parent-home/.pi-agents",
    sessionsHome: "/tmp/pi-save-default-1234",
    piConfigHome: undefined,
    manifestPath: expect.stringMatching(/\/runtime\/cohort-manifest\.json$/u),
  }));
  expect(output.stderr).toEqual([]);
});

it("preserves explicit native overrides and allows fixture configuration only in fake mode", async () => {
  const output = capture();
  const openManager = vi.fn(async () => {});

  expect(await main([
    "--fake",
    "--cwd", "other-project",
    "--state", "records",
    "--sessions", "/tmp/private-runtime",
    "--pi-config", "pi-config",
  ], {
    ...output.streams,
    openManager,
    cwd: "/private/project",
    homeDir: "/private/parent-home",
    uid: 1234,
  })).toBe(0);

  expect(openManager).toHaveBeenCalledWith(expect.objectContaining({
    mode: "fake",
    projectCwd: "/private/project/other-project",
    stateHome: "/private/project/records",
    sessionsHome: "/tmp/private-runtime",
    piConfigHome: "/private/project/pi-config",
  }));
});

it.each([
  [["agents"], "unsupported argument agents"],
  [["daemon", "status"], "unsupported argument daemon"],
  [["--state"], "--state needs a directory"],
  [["--sessions", "--real"], "--sessions needs a directory"],
  [["--real", "--fake"], "--real conflicts with --fake"],
  [["--pi-config", "/private/pi"], "--pi-config is only accepted with --fake"],
  [["--cwd", "/one", "--cwd", "/two"], "--cwd may be given only once"],
])("refuses invalid public argv before opening the manager: %j", async (argv, message) => {
  const output = capture();
  const openManager = vi.fn(async () => {});
  expect(await main(argv, {
    ...output.streams,
    openManager,
    cwd: "/private/project",
    homeDir: "/private/parent-home",
    uid: 1234,
  })).toBe(2);
  expect(openManager).not.toHaveBeenCalled();
  expect(output.stderr.join("")).toContain(message);
});

it.each([
  ["--help", "Usage: pi-agents"],
  ["--version", "pi-agents 0.0.2"],
])("handles %s at the public entry before old state adoption", async (argument, expected) => {
  const fixture = await privateParent();
  const legacy = path.join(fixture.state, "pi-agents-dashboard");
  const destination = path.join(fixture.state, "pi-agents");
  await Promise.all([mkdir(legacy, { recursive: true }), mkdir(destination, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(legacy, "legacy-marker"), "legacy\n"),
    writeFile(path.join(destination, "destination-marker"), "destination\n"),
  ]);

  const result = await execFileAsync(process.execPath, [PUBLIC_ENTRY.pathname, argument], {
    cwd: fixture.root,
    env: { ...process.env, HOME: fixture.home, XDG_STATE_HOME: fixture.state },
    encoding: "utf8",
  });

  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(expected);
  expect(await readFile(path.join(legacy, "legacy-marker"), "utf8")).toBe("legacy\n");
  expect(await readFile(path.join(destination, "destination-marker"), "utf8")).toBe("destination\n");
});
