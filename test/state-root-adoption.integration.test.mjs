import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { runDaemonCommand } from "../cli/daemon-commands.mjs";
import { adoptRenamedStateRoot } from "../runtime/state-root-adoption.mjs";

const execFileAsync = promisify(execFile);
const executable = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-agents.mjs");
const DEAD_PID = 0x7ffffffe;
const parents = [];
const startedRoots = [];

afterEach(async () => {
  for (const root of startedRoots.splice(0)) await runDaemonCommand("stop", { root, allowLiveWorkers: true }).catch(() => {});
  await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
});

/** @param {string} root @param {string} sessionId */
function record(root, sessionId) {
  const at = "2026-08-25T12:00:00.000Z";
  const canonicalSessionFile = join(root, "canonical", `${sessionId}.jsonl`);
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId,
    sessionFile: canonicalSessionFile,
    canonicalSessionFile,
    cwd: root,
    taskState: "READY",
    processState: "EXITED",
    outcome: "NONE",
    activity: { kind: "saved_session", summary: "Saved", updatedAt: at },
    createdAt: at,
    updatedAt: at,
  };
}

/** Build a state root under the name the product shipped before the pi-agents rename. @param {string[]} sessionIds */
async function previousStateRoot(sessionIds) {
  const parent = await mkdtemp(join(tmpdir(), "pi-agents-adoption-integration-"));
  parents.push(parent);
  const previousRoot = join(parent, "pi-dashboard");
  for (const directory of ["canonical", "daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(previousRoot, directory), { recursive: true, mode: 0o700 });
  for (const sessionId of sessionIds) {
    await writeFile(join(previousRoot, "sessions", `${sessionId}.json`), `${JSON.stringify(record(previousRoot, sessionId), null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(previousRoot, "canonical", `${sessionId}.jsonl`), "", { mode: 0o600 });
  }
  // A worker lease records process identities and no path at all, so it must still validate once
  // the root it was written under has a different name.
  const identity = { pid: DEAD_PID, startIdentity: "1", processGroupId: DEAD_PID };
  await writeFile(join(previousRoot, "daemon", "workers.json"), JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: sessionIds[0], runId: "run-adopted", leaseId: "lease-adopted", generation: 1, identity, piChildIdentity: identity }] }), { mode: 0o600 });
  return { parent, previousRoot, root: join(parent, "pi-agents"), env: { HOME: parent, XDG_STATE_HOME: parent } };
}

/** @param {string} root */
async function listSessionsThroughDaemon(root) {
  const client = createDaemonClient({
    socketPath: join(root, "daemon", "control.sock"),
    token: (await readFile(join(root, "daemon", "control.token"), "utf8")).trim(),
    clientId: "adoption-integration",
    reconnect: false,
    maxBytes: 256 * 1024,
  });
  await client.connect();
  try {
    const state = await client.request({ version: 1, clientId: "adoption-integration", requestId: "state", op: "get_state", payload: {} });
    if (!state.ok) throw new Error(`get_state failed: ${JSON.stringify(state)}`);
    return state.result.sessions.map((/** @type {any} */ session) => session.sessionId).sort();
  } finally {
    await client.close();
  }
}

it("lists every session from the previous state root after startup under the new root", async () => {
  const { root, env } = await previousStateRoot(["alpha", "beta", "gamma", "delta"]);

  expect(await adoptRenamedStateRoot({ env })).toMatchObject({ status: "ADOPTED", root });

  const started = await runDaemonCommand("start", { root });
  startedRoots.push(root);
  expect(started).toMatchObject({ code: 0, result: { kind: "daemon_started" } });

  expect(await listSessionsThroughDaemon(root)).toEqual(["alpha", "beta", "delta", "gamma"]);
}, 30_000);

it("recovers a crashed previous daemon whose publication still names the previous root", async () => {
  const { previousRoot, root, env } = await previousStateRoot(["alpha", "beta"]);
  await writeFile(join(previousRoot, "daemon", "pid.json"), JSON.stringify({ schemaVersion: 1, pid: DEAD_PID, startIdentity: "1", processGroupId: DEAD_PID, daemonEpoch: "epoch", tokenPath: join(previousRoot, "daemon", "control.token"), startedAt: "2026-08-25T12:00:00.000Z", state: "READY" }), { mode: 0o600 });

  expect(await adoptRenamedStateRoot({ env })).toMatchObject({ status: "ADOPTED", root });

  expect(await runDaemonCommand("start", { root })).toMatchObject({ code: 1, error: { code: "STALE_ENDPOINT_REQUIRES_RECOVER" } });
  const recovered = await runDaemonCommand("recover", { root });
  startedRoots.push(root);
  expect(recovered).toMatchObject({ code: 0, result: { publication: { tokenPath: join(root, "daemon", "control.token") } } });

  expect(await listSessionsThroughDaemon(root)).toEqual(["alpha", "beta"]);
}, 30_000);

it("adopts from the executable itself, before any command resolves a state root", async () => {
  const { parent, previousRoot, root, env } = await previousStateRoot(["alpha", "beta", "gamma", "delta"]);

  const status = await execFileAsync(process.execPath, [executable, "daemon", "status", "--json"], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" }).catch((/** @type {any} */ error) => error);

  expect(status.code).toBe(3);
  expect(status.stderr).toContain(`Adopted ${previousRoot} as ${root}`);
  expect(JSON.parse(status.stdout)).toMatchObject({ result: { kind: "daemon_status", root, status: "ABSENT" } });
  expect(await readdir(parent)).toEqual(["pi-agents"]);
  expect((await readdir(join(root, "sessions"))).sort()).toEqual(["alpha.json", "beta.json", "delta.json", "gamma.json"]);
  await expect(lstat(previousRoot)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("keeps using the previous root when the new root exists but holds no sessions", async () => {
  // Inverted 2026-08-30: any command creates `cli/` in the new root, so refusing on its mere
  // existence stranded six live sessions behind STATE_ROOTS_SPLIT. A split needs sessions on both sides.
  const { previousRoot, root, env } = await previousStateRoot(["alpha", "beta"]);
  await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 });

  const adoption = await adoptRenamedStateRoot({ env });

  expect(adoption).toMatchObject({ status: "DESTINATION_ROOT_EMPTY", root: previousRoot });
});

it("still refuses when both roots hold sessions", async () => {
  const { previousRoot, root, env } = await previousStateRoot(["alpha", "beta"]);
  await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "sessions", "gamma.json"), "{}", { mode: 0o600 });

  const refusal = await adoptRenamedStateRoot({ env }).catch((error) => error);

  expect(refusal).toMatchObject({ code: "STATE_ROOTS_SPLIT" });
  expect(refusal.message).toContain(`${previousRoot} (2 sessions)`);
  expect(refusal.message).toContain(`${root} (1 session)`);
});
