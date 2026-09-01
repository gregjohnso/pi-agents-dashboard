import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { expectDaemonCommand } from "./daemon-command-assertions.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const fakePiSource = await readFile(fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url)), "utf8");
// This box runs at load 30 while the suite starts its own daemons in parallel, so a cold start is
// budgeted well above the product's own expectation and named here rather than repeated per call.
const STARTUP_DEADLINE_MS = 30_000;
// Short enough to observe twice inside one test. The shipped default is pinned in
// `runtime/idle-exit.test.mjs`; what this suite tests is the behaviour at whatever window is set.
const IDLE_WINDOW_MS = 2_500;
const harness = createRealProcessHarness("idle-exit-acceptance");

afterEach(() => harness.cleanup());

/** @param {{ pid: number, startIdentity: string, processGroupId: number }} identity */
async function stillRunning(identity) {
  try {
    const actual = await inspectProcessIdentity(identity.pid);
    return actual.pid === identity.pid && actual.startIdentity === identity.startIdentity && actual.processGroupId === identity.processGroupId;
  } catch {
    return false;
  }
}

/** Every byte the workers have written of Pi's own output, which is what grows with no daemon present. @param {string} root */
async function recordedPiBytes(root) {
  let total = 0;
  for (const runHash of await readdir(join(root, "runs"))) {
    const directory = join(root, "runs", runHash, "diagnostics");
    for (const name of await readdir(directory).catch(() => [])) total += (await stat(join(directory, name))).size;
  }
  return total;
}

/** @param {string} root @param {string} clientId */
async function dashboard(root, clientId) {
  const client = createDaemonClient({
    socketPath: join(root, "daemon", "control.sock"),
    token: (await readFile(join(root, "daemon", "control.token"), "utf8")).trim(),
    clientId,
    attachId: clientId,
    reconnect: false,
    maxBytes: 256 * 1024,
  });
  await client.connect();
  /** @param {string} requestId @param {string} op @param {any} payload */
  const send = (requestId, op, payload) => client.request({ version: 1, clientId, requestId, op, payload });
  return { client, send, close: () => client.close() };
}

/** @param {any} client @param {string} sessionId */
async function viewerItemCount(client, sessionId) {
  const { snapshot, unsubscribe } = await client.subscribeViewer(sessionId);
  unsubscribe();
  return snapshot.items.length;
}

// Operator-visible behaviour: closing every dashboard leaves no resident daemon, and the sessions the
// operator left running are still running, still recording, and all present in the next dashboard.
it("exits when the last dashboard closes, keeps every session running, and finds them all again", async () => {
  const root = await harness.stateRoot("pi-agents-idle-exit-", ["canonical", "daemon", "sessions", "queue", "runs", "index", "work-one", "work-two"]);
  const executable = join(root, "pi");
  await writeFile(executable, fakePiSource, { mode: 0o700 });
  await chmod(executable, 0o700);
  // Pi streams without being prompted, which is a session doing work with nobody watching it.
  const env = { ...process.env, FAKE_PI_STREAM_MS: "200", PI_AGENTS_IDLE_EXIT_MS: String(IDLE_WINDOW_MS) };

  const started = await harness.daemon("start", { root, piBin: executable, env, timeoutMs: STARTUP_DEADLINE_MS });
  expectDaemonCommand("start", started, { code: 0, result: { kind: "daemon_started" } });
  const exitingDaemon = started.result.publication;

  const registry = new RegistryStore(join(root, "sessions"));
  /** @type {Record<string, number>} */
  const itemsBefore = {};
  /** @type {any[]} */
  const workers = [];
  const first = await dashboard(root, "idle-exit-before");
  try {
    for (const name of ["one", "two"]) {
      // One directory per session: shared-directory isolation refuses a second launch into a
      // directory whose owners changed since the warning the frontend showed.
      const cwd = join(root, `work-${name}`);
      const launched = await first.send(`launch-${name}`, "launch", {
        prompt: `bounded fake task ${name}`,
        cwd,
        sourceSessionId: "idle-exit-source",
        isolation: { mode: "shared_directory", confirmedCwd: cwd, ownerSessionIds: [] },
      });
      if (!launched.ok) throw new Error(`Launch ${name} failed: ${JSON.stringify(launched)}`);
      const record = await registry.get(launched.result.sessionId);
      // Recorded before anything can time out: the window between the launch and this append is the
      // only window in which a killed run still leaks a worker and its Pi child.
      workers.push(await harness.record(`worker ${name}`, record.ownership.process));
      itemsBefore[launched.result.sessionId] = await viewerItemCount(first.client, launched.result.sessionId);
    }
    expect(workers).toHaveLength(2);
  } finally {
    await first.close();
  }

  // Nothing signals the daemon. It is the last dashboard closing that ends it.
  await vi.waitFor(async () => expect(await stillRunning(exitingDaemon)).toBe(false), { timeout: IDLE_WINDOW_MS * 8, interval: 200 });

  const bytesAtExit = await recordedPiBytes(root);
  for (const worker of workers) expect(await stillRunning(worker)).toBe(true);
  await delay(IDLE_WINDOW_MS);
  for (const worker of workers) expect(await stillRunning(worker)).toBe(true);
  // Pi kept running and the worker kept recording it, with no daemon in the process tree at all.
  expect(await recordedPiBytes(root)).toBeGreaterThan(bytesAtExit);

  const next = await harness.daemon("start", { root, piBin: executable, env, timeoutMs: STARTUP_DEADLINE_MS });
  expectDaemonCommand("start", next, { code: 0, result: { kind: "daemon_started", alreadyRunning: false } });
  expect(next.result.publication.pid).not.toBe(exitingDaemon.pid);

  const second = await dashboard(root, "idle-exit-after");
  try {
    const state = await second.send("state", "get_state", {});
    if (!state.ok) throw new Error(`get_state failed: ${JSON.stringify(state)}`);
    expect(state.result.sessions.map((/** @type {any} */ session) => session.sessionId).sort()).toEqual(Object.keys(itemsBefore).sort());
    for (const session of state.result.sessions) {
      expect(session).toMatchObject({ processState: "LIVE", isolation: { mode: "shared_directory", canonicalCwd: join(root, session.cwd.endsWith("work-one") ? "work-one" : "work-two") } });
      // The transcript the operator gets back is longer than the one he left, so the work the
      // session did while no dashboard was open reached him rather than being dropped.
      await vi.waitFor(async () => expect(await viewerItemCount(second.client, session.sessionId)).toBeGreaterThan(itemsBefore[session.sessionId]), { timeout: 10_000, interval: 250 });
    }
  } finally {
    await second.close();
  }
}, 120_000);
