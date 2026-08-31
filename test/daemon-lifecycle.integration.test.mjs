import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, it } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { runDaemonCommand } from "../cli/daemon-commands.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { expectDaemonCommand } from "./daemon-command-assertions.mjs";

/** @type {string[]} */
const parents = [];
/** @type {string[]} */
const startedRoots = [];
// Every case here spawns a real detached daemon, and this box runs at load 30 while the suite does
// the same in parallel. The command's own default is 90 s; 45 s is this suite's tighter budget,
// chosen so a daemon that never publishes is named well inside the 120 s test timeout.
const STARTUP_DEADLINE_MS = 45_000;

afterEach(async () => {
  for (const root of startedRoots.splice(0)) await runDaemonCommand("stop", { root, allowLiveWorkers: true }).catch(() => {});
  await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
});

/** Build the state parent a start with no explicit root would resolve against. @param {string[]} sessionIds */
async function stateParent(sessionIds) {
  const parent = await mkdtemp(join(tmpdir(), "pi-agents-daemon-lifecycle-"));
  parents.push(parent);
  // The daemon child resolves its Pi agent directory from HOME, so the throwaway home needs one.
  await mkdir(join(parent, ".pi", "agent"), { recursive: true, mode: 0o700 });
  const previousRoot = join(parent, "pi-dashboard");
  const at = "2026-08-25T12:00:00.000Z";
  for (const directory of ["canonical", "daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(previousRoot, directory), { recursive: true, mode: 0o700 });
  for (const sessionId of sessionIds) {
    const canonicalSessionFile = join(previousRoot, "canonical", `${sessionId}.jsonl`);
    const record = {
      schemaVersion: 1, revision: 0, sessionId, sessionFile: canonicalSessionFile, canonicalSessionFile, cwd: previousRoot,
      taskState: "READY", processState: "EXITED", outcome: "NONE",
      activity: { kind: "saved_session", summary: "Saved", updatedAt: at }, createdAt: at, updatedAt: at,
    };
    await writeFile(join(previousRoot, "sessions", `${sessionId}.json`), JSON.stringify(record), { mode: 0o600 });
    await writeFile(canonicalSessionFile, "", { mode: 0o600 });
  }
  return { parent, previousRoot, env: { ...process.env, HOME: parent, XDG_STATE_HOME: parent, PI_AGENTS_STATE_DIR: undefined } };
}

/** @param {string} root */
async function listSessionsThroughDaemon(root) {
  const client = createDaemonClient({
    socketPath: join(root, "daemon", "control.sock"),
    token: (await readFile(join(root, "daemon", "control.token"), "utf8")).trim(),
    clientId: "daemon-lifecycle-integration",
    reconnect: false,
    maxBytes: 256 * 1024,
  });
  await client.connect();
  try {
    const state = await client.request({ version: 1, clientId: "daemon-lifecycle-integration", requestId: "state", op: "get_state", payload: {} });
    if (!state.ok) throw new Error(`get_state failed: ${JSON.stringify(state)}`);
    return state.result.sessions.map((/** @type {any} */ session) => session.sessionId).sort();
  } finally {
    await client.close();
  }
}

/**
 * List the daemon processes started against exactly one state root.
 *
 * The root is a `mkdtemp` path this test owns, so an exact `--root <root>` argument match cannot
 * name a daemon belonging to the operator or to a concurrently running suite.
 *
 * @param {string} root
 * @returns {number[]}
 */
function daemonsRootedAt(root) {
  const listing = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return listing.split("\n")
    .filter((line) => line.includes("runtime/daemon.mjs") && line.includes(`--root ${root}`))
    .map((line) => Number(line.trim().split(/\s+/u)[0]))
    .filter((pid) => Number.isSafeInteger(pid));
}

/** @param {any} identity */
async function stillRunning(identity) {
  try {
    const actual = await inspectProcessIdentity(identity.pid);
    return actual.pid === identity.pid && actual.startIdentity === identity.startIdentity && actual.processGroupId === identity.processGroupId;
  } catch {
    return false;
  }
}

it("starts against the sessions the operator already has when no root is given", async () => {
  const sessionIds = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const { env } = await stateParent(sessionIds);

  const started = await runDaemonCommand("start", { env, timeoutMs: STARTUP_DEADLINE_MS });
  expectDaemonCommand("start", started, { code: 0, result: { kind: "daemon_started" } });
  startedRoots.push(started.result.root);

  expect(await listSessionsThroughDaemon(started.result.root)).toEqual([...sessionIds].sort());
}, 120_000);

it("stops the daemon child a start gave up on instead of leaving it to publish itself", async () => {
  // A start that reached its deadline returned DAEMON_START_FAILED and left its detached child
  // running; the child published itself seconds later and lived forever. 47 such daemons leaked in
  // one night, the oldest up 38 hours. A deadline far below a real cold start forces that window.
  const { previousRoot, env } = await stateParent(["alpha"]);

  // Registered before the assertions: a regression leaves a live daemon that teardown must reap.
  startedRoots.push(previousRoot);
  const started = await runDaemonCommand("start", { root: previousRoot, env, timeoutMs: 200 });
  expect(started).toMatchObject({ code: 1, error: { code: "DAEMON_START_FAILED" } });

  // The leak was visible only after the abandoned child finished starting, so absence has to be
  // observed past the point where it would have published itself.
  await delay(5_000);
  expect(daemonsRootedAt(previousRoot)).toEqual([]);
  // A stopped child that had already published must not leave the endpoint that refuses the
  // operator's next start with STALE_ENDPOINT_REQUIRES_RECOVER.
  const restarted = await runDaemonCommand("start", { root: previousRoot, env, timeoutMs: STARTUP_DEADLINE_MS });
  expectDaemonCommand("start", restarted, { code: 0, result: { kind: "daemon_started", alreadyRunning: false } });
}, 120_000);

it("replaces the daemon on restart, leaving one process and a publication that names it", async () => {
  const { previousRoot, env } = await stateParent(["alpha"]);

  const started = await runDaemonCommand("start", { root: previousRoot, env, timeoutMs: STARTUP_DEADLINE_MS });
  expectDaemonCommand("start", started, { code: 0, result: { kind: "daemon_started" } });
  startedRoots.push(previousRoot);
  const before = started.result.publication;

  const restarted = await runDaemonCommand("restart", { root: previousRoot, env, timeoutMs: STARTUP_DEADLINE_MS });
  expectDaemonCommand("restart", restarted, { code: 0, result: { kind: "daemon_started" } });
  const after = restarted.result.publication;

  expect(after.pid).not.toBe(before.pid);
  expect(await stillRunning(before)).toBe(false);
  expect(await stillRunning(after)).toBe(true);
  expect(JSON.parse(await readFile(join(previousRoot, "daemon", "pid.json"), "utf8"))).toMatchObject({ pid: after.pid, startIdentity: after.startIdentity, processGroupId: after.processGroupId });
}, 120_000);
