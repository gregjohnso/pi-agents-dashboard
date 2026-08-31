import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, expect, it } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { DashboardController, createDaemonDashboardBackend } from "../app/list/dashboard.mjs";
import { createDaemonRuntime } from "../runtime/daemon.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";

// The operator's own numbers: a list history of 6778 records, 18 MB of it on his machine, which the
// dashboard used to replay on every start.
const RETIRED_LOG_LENGTH = 6_778;
const EPOCH = "resync-acceptance-epoch";
const AT = "2026-08-25T12:00:00.000Z";

/** @type {string[]} */
const roots = [];
/** @type {any[]} */
const runtimes = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** @param {string} root @param {string} sessionId @param {Record<string, any>} [overrides] */
function sessionRecord(root, sessionId, overrides = {}) {
  const canonicalSessionFile = join(root, "canonical", `${sessionId}.jsonl`);
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId,
    sessionFile: canonicalSessionFile,
    canonicalSessionFile,
    cwd: root,
    name: sessionId,
    taskState: "READY",
    processState: "EXITED",
    outcome: "NONE",
    activity: { kind: "saved_session", summary: `Activity ${sessionId}`, updatedAt: AT },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/**
 * One state root holding two sessions and a retired list history of `RETIRED_LOG_LENGTH` records.
 * The history is left exactly where it lies: nothing may parse, replay, migrate, or delete it.
 * @param {string} clientId
 */
async function seedRoot(clientId) {
  const root = await mkdtemp(join(tmpdir(), "pi-agents-resync-acceptance-"));
  roots.push(root);
  for (const directory of ["canonical", "daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "daemon", "epoch"), `${EPOCH}\n`, { mode: 0o600 });

  const registry = new RegistryStore(join(root, "sessions"));
  await registry.create(sessionRecord(root, "alpha"));
  await registry.create(sessionRecord(root, "beta", { taskState: "WORKING", processState: "LIVE" }));

  const lines = [];
  for (let sequence = 1; sequence <= RETIRED_LOG_LENGTH; sequence += 1) {
    lines.push(JSON.stringify({ version: 1, cursor: { daemonEpoch: EPOCH, sequence: String(sequence) }, occurredAt: AT, kind: "attachment_changed", payload: { sessionId: "alpha", clientId, role: "composer", attached: sequence % 2 === 1 } }));
  }
  await writeFile(join(root, "index", "events.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });

  const launchDraft = { prompt: "", cwd: root, isolationMode: "worktree", model: { provider: "", id: "" }, name: "" };
  // The retired shared frontend state, left where it lies with the cursor that used to crash a start.
  // No dashboard reads or writes it any more; each one keeps its view state in its own process.
  await writeFile(join(root, "frontend-state.json"), `${JSON.stringify({ schemaVersion: 1, clientId, cursor: { daemonEpoch: EPOCH, sequence: "2" }, viewState: {}, launchDraft })}\n`, { mode: 0o600 });
  return root;
}

/** Count the requests the list actually puts on the wire. @param {any} client @param {string[]} operations */
function recordingRequests(client, operations) {
  return {
    ...client,
    request(/** @type {any} */ request) {
      operations.push(request.op);
      return client.request(request);
    },
    subscribeListChanges(/** @type {any} */ onChanged) {
      operations.push("subscribe_list_changes");
      return client.subscribeListChanges(onChanged);
    },
  };
}

/** Open one real dashboard against one real daemon and return what the operator would see. @param {{ root: string, clientId: string, attachId?: string }} options */
async function openDashboard({ root, clientId, attachId = "resync-acceptance-process" }) {
  const runtime = await createDaemonRuntime({ root, hostProbe: async () => ({ blockers: [] }), reconnectTimeoutMs: 2_000 });
  runtimes.push(runtime);
  await runtime.ready;
  const client = createDaemonClient({ socketPath: runtime.socketPath, token: runtime.token, clientId, attachId, maxBytes: 256 * 1024, reconnect: false });
  /** @type {string[]} */
  const operations = [];
  const backend = createDaemonDashboardBackend({ client: recordingRequests(client, operations), clientId, preflight: async (/** @type {any} */ draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
  /** @type {any} */
  let dashboard;
  dashboard = new DashboardController({
    backend,
    openViewer: async () => {},
    clientId,
    sourceSessionId: `dashboard-${clientId}`,
    launchDefaults: { cwd: root },
    requestRender: () => { queueMicrotask(() => { dashboard.render(120, 24); }); },
  });
  await dashboard.open();
  return {
    dashboard,
    operations,
    runtime,
    async close() {
      await dashboard.close();
      await client.close();
    },
    rows() {
      return dashboard.render(120, 24).map((/** @type {string} */ line) => stripVTControlCharacters(line));
    },
  };
}

/** @param {any} runtime @param {string} clientId */
async function readState(runtime, clientId) {
  const client = createDaemonClient({ socketPath: runtime.socketPath, token: runtime.token, clientId, maxBytes: 256 * 1024, reconnect: false });
  try {
    const response = await client.request({ version: 1, clientId, requestId: `read-${Date.now()}`, op: "get_state", payload: {} });
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  } finally {
    await client.close();
  }
}

// Operator-visible failure: the dashboard crashed on every start with
// "SUBSCRIBER_OVERFLOW: Client subscriber exceeded its bounded queue" and rewrote the same stale cursor.
it("starts from current rows beside a retired list history it never opens", async () => {
  const clientId = "resync-acceptance-current";
  const root = await seedRoot(clientId);
  const historyBefore = await readFile(join(root, "index", "events.jsonl"), "utf8");
  const frontendStateBefore = await readFile(join(root, "frontend-state.json"), "utf8");
  const opened = await openDashboard({ root, clientId });
  try {
    expect(opened.dashboard.status).toEqual({ kind: "ready" });
    expect(opened.dashboard.sessions.map((/** @type {any} */ record) => record.sessionId)).toEqual(["alpha", "beta"]);
    opened.dashboard.setView("all");
    expect(opened.rows().join("\n")).toContain("alpha");
    expect(opened.rows().join("\n")).toContain("beta");
    // Subscribe first, then read: that order is what makes the read safe, and it costs one read.
    expect(opened.operations).toEqual(["subscribe_list_changes", "get_state"]);
    expect(opened.dashboard.coverageCursor).toMatchObject({ sequence: expect.stringMatching(/^(0|[1-9]\d*)$/u) });
  } finally {
    await opened.close();
  }
  // The retired history and the retired shared frontend state both stay exactly as they were: no
  // parser, no migration, no deletion, and above all no writer.
  expect(await readFile(join(root, "index", "events.jsonl"), "utf8")).toBe(historyBefore);
  expect(await readFile(join(root, "frontend-state.json"), "utf8")).toBe(frontendStateBefore);
}, 60_000);

// Operator-visible failure: a burst of changes filled the bounded replay queue, and every dropped
// record left a row permanently wrong. The read-per-change bound is pinned by the focused
// ten-thousand-notification test; what this proves against a real daemon is convergence.
it("converges on the daemon's own rows after a burst of changes", async () => {
  const clientId = "resync-acceptance-burst";
  const root = await seedRoot(clientId);
  const opened = await openDashboard({ root, clientId });
  try {
    const readsBefore = opened.operations.filter((operation) => operation === "get_state").length;
    const colors = ["sky", "green", "amber", "rose", "cyan", "gray"];
    const mutator = createDaemonClient({ socketPath: opened.runtime.socketPath, token: opened.runtime.token, clientId: "burst-mutator", maxBytes: 256 * 1024, reconnect: false });
    try {
      // Concurrent, because a burst is what filled the old replay queue; one change per read is not.
      await Promise.all(Array.from({ length: 120 }, (_unused, index) => mutator.setSessionColor(index % 2 === 0 ? "alpha" : "beta", colors[index % colors.length])));
    } finally {
      await mutator.close();
    }
    const expected = await readState(opened.runtime, "reader");
    await vi_waitFor(() => {
      const rows = opened.dashboard.sessions.map((/** @type {any} */ record) => ({ sessionId: record.sessionId, color: record.color, revision: record.revision }));
      expect(rows).toEqual(expected.sessions.map((/** @type {any} */ record) => ({ sessionId: record.sessionId, color: record.color, revision: record.revision })));
    });
    expect(opened.dashboard.status).toEqual({ kind: "ready" });
    // A change never costs more than one read, so the reads cannot amplify with the burst.
    const reads = opened.operations.filter((operation) => operation === "get_state").length - readsBefore;
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(121);
    expect(opened.dashboard.listChangePending).toBe(false);
  } finally {
    await opened.close();
  }
}, 60_000);

/** @param {() => void} assertion */
async function vi_waitFor(assertion) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
