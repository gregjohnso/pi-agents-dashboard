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
    timeoutMs: 1_000,
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
  const entries = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(entries.some((entry) => entry.providerInvocation === true)).toBe(false);
  expect(entries.some((entry) => entry.valid === true)).toBe(false);
  expect(entries.some((entry) => entry.argv?.includes(canonicalSession))).toBe(false);
  expect(entries.filter((entry) => entry.kind === "start")).toHaveLength(2);
});

it("caches by complete executable identity and invalidates after replacement", async () => {
  const { log, executable } = await setup();
  const cache = new Map();
  const options = { executable, cache, timeoutMs: 1_000, env: { ...process.env, FAKE_PI_LOG: log } };
  const first = await probePiCapabilities(options);
  const second = await probePiCapabilities(options);
  expect(second).toBe(first);
  expect((await readFile(log, "utf8")).trim().split("\n").filter((line) => JSON.parse(line).kind === "start")).toHaveLength(2);

  await writeFile(executable.realpath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await expect(probePiCapabilities(options)).rejects.toMatchObject({ code: "PI_EXECUTABLE_REPLACED" });
});

it("reports missing required commands and malformed JSONL without inference", async () => {
  const missing = await setup();
  const report = await probePiCapabilities({
    executable: missing.executable,
    cache: new Map(),
    timeoutMs: 1_000,
    env: { ...process.env, FAKE_PI_LOG: missing.log, FAKE_PI_MISSING: "steer" },
  });
  expect(report.missingRequired).toContain("steer");

  const malformed = await setup();
  const malformedReport = await probePiCapabilities({
    executable: malformed.executable,
    cache: new Map(),
    timeoutMs: 1_000,
    env: { ...process.env, FAKE_PI_LOG: malformed.log, FAKE_PI_MALFORMED: "1" },
  });
  expect(malformedReport).toMatchObject({ jsonl: false });
  expect(malformedReport.missingRequired).toContain("jsonl");
});
