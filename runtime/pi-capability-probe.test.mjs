import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { probePiCapabilities } from "./pi-capability-probe.mjs";
import { resolvePiExecutable } from "./pi-executable.mjs";

const FIXTURE = fileURLToPath(new URL("../test/fixtures/fake-pi.mjs", import.meta.url));
/** @type {string[]} */
const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-probe-"));
  cleanup.push(root);
  const executable = join(root, "pi");
  const log = join(root, "commands.jsonl");
  await copyFile(FIXTURE, executable);
  await chmod(executable, 0o700);
  return { root, log, executable: await resolvePiExecutable({ cliPath: executable, pathEnv: "" }) };
}

it("probes recognized validation errors without a valid prompt or canonical session", async () => {
  const { root, log, executable } = await setup();
  const canonicalSession = join(root, "canonical-session.jsonl");
  const report = await probePiCapabilities({
    executable,
    cache: new Map(),
    timeoutMs: 5_000,
    env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_VERSION: "version-A" },
  });

  expect(report).toMatchObject({
    executable,
    reportedVersion: "version-A",
    rpcMode: true,
    jsonl: true,
    missingRequired: [],
  });
  expect(report.commands).toEqual(["get_state", "prompt", "follow_up", "steer", "abort", "extension_ui_response"]);
  expect(report.events).toContain("required_live_events");
  const entries = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(entries.some((entry) => entry.providerInvocation === true)).toBe(false);
  expect(entries.some((entry) => entry.valid === true)).toBe(false);
  expect(entries.some((entry) => entry.argv?.includes(canonicalSession))).toBe(false);
  expect(entries.filter((entry) => entry.kind === "start")).toHaveLength(2);
});

it("recognizes RPC mode from the successful handshake instead of help formatting", async () => {
  const { log, executable } = await setup();
  const report = await probePiCapabilities({
    executable,
    cache: new Map(),
    timeoutMs: 5_000,
    env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_STOCK_HELP: "1", FAKE_PI_ONE_WAY_EXTENSION_UI_RESPONSE: "1" },
  });

  expect(report.rpcMode).toBe(true);
  expect(report.missingRequired).toEqual([]);
});

it("accepts stock Pi's one-way extension UI response protocol", async () => {
  const { log, executable } = await setup();
  const report = await probePiCapabilities({
    executable,
    cache: new Map(),
    timeoutMs: 5_000,
    env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_ONE_WAY_EXTENSION_UI_RESPONSE: "1" },
  });

  expect(report.missingRequired).toEqual([]);
  expect(report.commands).toContain("extension_ui_response");
});

it("rejects a delayed unknown-command response for extension UI responses", async () => {
  const { log, executable } = await setup();
  const report = await probePiCapabilities({
    executable,
    cache: new Map(),
    timeoutMs: 5_000,
    env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_DELAYED_UNKNOWN_EXTENSION_UI_RESPONSE_MS: "20" },
  });

  expect(report.commands).not.toContain("extension_ui_response");
  expect(report.missingRequired).toContain("extension_ui_response");
});

it.each([
  ["invalid UTF-8", { FAKE_PI_INVALID_UTF8: "1" }],
  ["an oversized frame", { FAKE_PI_OVERSIZED_FRAME: "1" }],
])("rejects %s through fatal bounded JSONL without inference", async (_label, behavior) => {
  const { log, executable } = await setup();
  const report = await probePiCapabilities({ executable, cache: new Map(), timeoutMs: 5_000, env: { ...process.env, FAKE_PI_LOG: log, ...behavior } });
  expect(report.jsonl).toBe(false);
  expect(report.missingRequired).toContain("jsonl");
  const entries = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(entries.some((entry) => entry.providerInvocation === true)).toBe(false);
});

it("requires correlated response IDs and an explicit unknown-command control response", async () => {
  const wrongId = await setup();
  const wrongIdReport = await probePiCapabilities({ executable: wrongId.executable, cache: new Map(), timeoutMs: 5_000, env: { ...process.env, FAKE_PI_LOG: wrongId.log, FAKE_PI_WRONG_RESPONSE_ID: "steer" } });
  expect(wrongIdReport.missingRequired).toContain("response_correlation");
  expect(wrongIdReport.commands).not.toContain("steer");

  const unknownAccepted = await setup();
  const unknownReport = await probePiCapabilities({ executable: unknownAccepted.executable, cache: new Map(), timeoutMs: 5_000, env: { ...process.env, FAKE_PI_LOG: unknownAccepted.log, FAKE_PI_UNKNOWN_SUCCESS: "1" } });
  expect(unknownReport.missingRequired).toContain("unknown_command_validation");
});

it("requires get_state to report the exact temporary non-canonical session", async () => {
  const { root, log, executable } = await setup();
  const canonicalSession = join(root, "canonical-session.jsonl");
  const report = await probePiCapabilities({ executable, cache: new Map(), timeoutMs: 5_000, env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_STATE_SESSION_PATH: canonicalSession } });
  expect(report.missingRequired).toContain("temporary_session_isolation");
  expect(report.commands).not.toContain("get_state");
  const starts = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.kind === "start");
  expect(starts.some((entry) => entry.argv.includes(canonicalSession))).toBe(false);
  expect(starts.find((entry) => entry.argv.includes("--session")).argv.join(" ")).toContain("pi-dashboard-probe-");
  expect(starts.some((entry) => entry.providerInvocation === true)).toBe(false);
});

it("caches by complete executable identity and invalidates after replacement", async () => {
  const { log, executable } = await setup();
  const cache = new Map();
  const options = { executable, cache, timeoutMs: 5_000, env: { ...process.env, FAKE_PI_LOG: log } };
  const first = await probePiCapabilities(options);
  const second = await probePiCapabilities(options);
  expect(second).toBe(first);
  expect((await readFile(log, "utf8")).trim().split("\n").filter((line) => JSON.parse(line).kind === "start")).toHaveLength(2);

  await writeFile(executable.realpath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await expect(probePiCapabilities(options)).rejects.toMatchObject({ code: "PI_EXECUTABLE_REPLACED" });
});

it("refuses when the selected adapter cannot normalize documented required live events without prompting Pi", async () => {
  const { log, executable } = await setup();
  const report = await probePiCapabilities({ executable, cache: new Map(), timeoutMs: 5_000, env: { ...process.env, FAKE_PI_LOG: log }, requiredEventProbe: () => false });
  expect(report.missingRequired).toContain("required_live_events");
  expect(report.events).not.toContain("required_live_events");
  const entries = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(entries.some((entry) => entry.providerInvocation === true || entry.valid === true)).toBe(false);
});

it("reports missing required commands and malformed JSONL without inference", async () => {
  const missing = await setup();
  const report = await probePiCapabilities({
    executable: missing.executable,
    cache: new Map(),
    timeoutMs: 5_000,
    env: { ...process.env, FAKE_PI_LOG: missing.log, FAKE_PI_MISSING: "steer" },
  });
  expect(report.missingRequired).toContain("steer");

  const malformed = await setup();
  const malformedReport = await probePiCapabilities({
    executable: malformed.executable,
    cache: new Map(),
    timeoutMs: 5_000,
    env: { ...process.env, FAKE_PI_LOG: malformed.log, FAKE_PI_MALFORMED: "1" },
  });
  expect(malformedReport).toMatchObject({ jsonl: false });
  expect(malformedReport.missingRequired).toContain("jsonl");
});
