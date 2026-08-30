import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, expect, it } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { DashboardController, createDaemonDashboardBackend } from "../app/list/dashboard.mjs";
import { createFrontendPersistence } from "../app/list/standalone-list.mjs";
import { createDaemonRuntime } from "../runtime/daemon.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";

// The operator's own numbers: a frontend cursor at sequence 2 against an event log at 6778.
const LOG_LENGTH = 6_778;
const STALE_SEQUENCE = "2";
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
 * One state root holding two sessions, an event log of `LOG_LENGTH` events, and one frontend state
 * file carrying `cursor` (a cursor near the start of the log, or none at all, which replays from
 * zero). `beta` reaches WORKING only in the last event, which is the change a client that falls
 * behind must not miss.
 * @param {string} clientId @param {{ daemonEpoch: string, sequence: string } | undefined} cursor
 */
async function seedRoot(clientId, cursor) {
  const root = await mkdtemp(join(tmpdir(), "pi-agents-resync-acceptance-"));
  roots.push(root);
  for (const directory of ["canonical", "daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "daemon", "epoch"), `${EPOCH}\n`, { mode: 0o600 });

  const registry = new RegistryStore(join(root, "sessions"));
  await registry.create(sessionRecord(root, "alpha"));
  await registry.create(sessionRecord(root, "beta", { taskState: "WORKING", processState: "LIVE" }));

  // Attachment events are the honest filler: one composer claim and its release per viewer visit,
  // and unlike session_changed they never supersede each other in a client's queue.
  const lines = [];
  for (let sequence = 1; sequence < LOG_LENGTH; sequence += 1) {
    lines.push(JSON.stringify({ version: 1, cursor: { daemonEpoch: EPOCH, sequence: String(sequence) }, occurredAt: AT, kind: "attachment_changed", payload: { sessionId: "alpha", clientId, role: "composer", attached: sequence % 2 === 1 } }));
  }
  lines.push(JSON.stringify({ version: 1, cursor: { daemonEpoch: EPOCH, sequence: String(LOG_LENGTH) }, occurredAt: AT, kind: "session_changed", payload: { session: sessionRecord(root, "beta", { taskState: "WORKING", processState: "LIVE" }) } }));
  await writeFile(join(root, "index", "events.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });

  const launchDraft = { prompt: "", cwd: root, isolationMode: "worktree", model: { provider: "", id: "" }, name: "" };
  await writeFile(join(root, "frontend-state.json"), `${JSON.stringify({ schemaVersion: 1, clientId, ...(cursor === undefined ? {} : { cursor }), viewState: {}, launchDraft })}\n`, { mode: 0o600 });
  return root;
}

/** Present a daemon that answers get_state with only {kind, sessions}, the build the operator is running. @param {any} client @param {{ count: number }} stateReads */
function withoutStateCursor(client, stateReads) {
  return {
    ...client,
    async request(/** @type {any} */ request) {
      const response = await client.request(request);
      if (request.op === "get_state") stateReads.count += 1;
      if (request.op !== "get_state" || !response.ok) return response;
      const { cursor: _cursor, ...result } = response.result;
      return { ...response, result };
    },
  };
}

/** Record the position the list actually asks the daemon to replay from. @param {any} client @param {{ after?: any }} seen */
function recordingSubscribe(client, seen) {
  return {
    ...client,
    subscribe(/** @type {any} */ after) {
      seen.after = after;
      return client.subscribe(after);
    },
  };
}

/** Open one real dashboard against one real daemon and return what the operator would see. @param {{ root: string, clientId: string, adaptClient?: (client: any) => any }} options */
async function openDashboard({ root, clientId, adaptClient = (client) => client }) {
  const runtime = await createDaemonRuntime({ root, hostProbe: async () => ({ blockers: [] }), reconnectTimeoutMs: 2_000 });
  runtimes.push(runtime);
  await runtime.ready;
  const client = createDaemonClient({ socketPath: runtime.socketPath, token: runtime.token, clientId, maxBytes: 256 * 1024, reconnect: false });
  /** @type {{ after?: any }} */
  const subscribed = {};
  const backend = createDaemonDashboardBackend({ client: recordingSubscribe(adaptClient(client), subscribed), clientId, preflight: async (/** @type {any} */ draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
  /** @type {any} */
  let dashboard;
  dashboard = new DashboardController({
    backend,
    persistence: createFrontendPersistence(join(root, "frontend-state.json"), clientId),
    openViewer: async () => {},
    clientId,
    sourceSessionId: `dashboard-${clientId}`,
    launchDefaults: { cwd: root },
    requestRender: () => { queueMicrotask(() => { dashboard.render(120, 24); }); },
  });
  await dashboard.open();
  return {
    dashboard,
    subscribed,
    async close() {
      await dashboard.close();
      await client.close();
    },
    rows() {
      return dashboard.render(120, 24).map((/** @type {string} */ line) => stripVTControlCharacters(line));
    },
    async persistedCursor() {
      return JSON.parse(await readFile(join(root, "frontend-state.json"), "utf8")).cursor;
    },
  };
}

/** Wait until the list stands at the head of the log, or until it dies trying. @param {any} opened */
async function settle(opened) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (opened.dashboard.status.kind === "error" || opened.dashboard.closed) return;
    if (opened.dashboard.cursor?.sequence === String(LOG_LENGTH)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Operator-visible failure: the dashboard crashed on every start with
// "SUBSCRIBER_OVERFLOW: Client subscriber exceeded its bounded queue" and rewrote the same stale cursor.
it("starts and lists its sessions with a persisted cursor thousands of events behind", async () => {
  const clientId = "resync-acceptance-current";
  const root = await seedRoot(clientId, { daemonEpoch: EPOCH, sequence: STALE_SEQUENCE });
  const opened = await openDashboard({ root, clientId });
  try {
    await settle(opened);
    expect(opened.dashboard.status).toEqual({ kind: "ready" });
    expect(opened.dashboard.sessions.map((/** @type {any} */ record) => record.sessionId)).toEqual(["alpha", "beta"]);
    opened.dashboard.setView("all");
    expect(opened.rows().join("\n")).toContain("alpha");
    expect(opened.rows().join("\n")).toContain("beta");
    // The snapshot is authoritative up to the daemon's own position, so the list subscribes there
    // and never asks for a replay of the 6776 events the snapshot already contains.
    expect(opened.subscribed.after).toEqual({ daemonEpoch: EPOCH, sequence: String(LOG_LENGTH) });
  } finally {
    await opened.close();
  }
  expect(await opened.persistedCursor()).toEqual({ daemonEpoch: EPOCH, sequence: String(LOG_LENGTH) });
}, 60_000);

// Operator-visible failure: against the daemon he is running, which does not report its position,
// the whole log replays at once and every dropped session_changed left a permanently wrong row.
// A crash also once wrote state with no cursor key, which replays from zero on the next start.
it.each([
  ["a cursor thousands of events behind", { daemonEpoch: EPOCH, sequence: STALE_SEQUENCE }],
  ["no cursor at all", undefined],
])("survives a full-log replay from an older daemon with %s and shows the session that changed during the gap", async (_label, persistedCursor) => {
  const clientId = `resync-acceptance-older-daemon-${persistedCursor === undefined ? "no-cursor" : "stale-cursor"}`;
  const root = await seedRoot(clientId, persistedCursor);
  const stateReads = { count: 0 };
  const opened = await openDashboard({ root, clientId, adaptClient: (client) => withoutStateCursor(client, stateReads) });
  try {
    await settle(opened);
    expect(opened.subscribed.after).toEqual(persistedCursor);
    expect(opened.dashboard.status).toEqual({ kind: "ready" });
    // The list is only correct because it read the daemon again after falling behind.
    expect(stateReads.count).toBeGreaterThan(1);
    expect(opened.dashboard.sessions.find((/** @type {any} */ record) => record.sessionId === "beta")?.taskState).toBe("WORKING");
    expect(opened.dashboard.sessions.map((/** @type {any} */ record) => record.sessionId)).toEqual(["alpha", "beta"]);
    // The replay is absorbed by a resynchronization, so the frontend ends up at the head of the log.
    expect((await opened.persistedCursor())?.sequence).toBe(String(LOG_LENGTH));
  } finally {
    await opened.close();
  }
}, 60_000);
