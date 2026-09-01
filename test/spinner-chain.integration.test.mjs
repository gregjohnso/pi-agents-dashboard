import net from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, expect, it, vi } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { DashboardController, createDaemonDashboardBackend } from "../app/list/dashboard.mjs";
import { SPINNER_INTERVAL_MS, spinnerFrame } from "../app/spinner.mjs";
import { createDaemonRuntime } from "../runtime/daemon.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { sessionEventForPiEvent } from "../runtime/session-event-mapping.mjs";

const WIDTH = 100;
const HEIGHT = 20;
// Title, working directory, section border, column header, then the first session row. The context
// line moved into the dock in a1bdf1e.
const FIRST_ROW = 4;
const FRAMES = new Set(Array.from({ length: 10 }, (_, index) => spinnerFrame(index * SPINNER_INTERVAL_MS)));

/** @type {any[]} */
const runtimes = [];
/** @type {any[]} */
const clients = [];
/** @type {any[]} */
const sockets = [];
/** @type {string[]} */
const roots = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const identity = { pid: 801, startIdentity: "throbber-worker", processGroupId: 801 };
const piChildIdentity = { pid: 802, startIdentity: "throbber-pi", processGroupId: 801 };
const at = "2026-08-25T12:00:00.000Z";

/** Start one daemon over a throwaway root that already owns a live, idle session. */
async function daemonWithLiveSession(sessionId) {
  const root = await mkdtemp(join(tmpdir(), "pi-agents-throbber-"));
  roots.push(root);
  for (const name of ["daemon", "sessions", "runs", "index"]) await mkdir(join(root, name), { mode: 0o700 });
  const registry = new RegistryStore(join(root, "sessions"));
  await registry.create({
    schemaVersion: 1, revision: 0, sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, canonicalSessionFile: `/sessions/${sessionId}.jsonl`,
    cwd: "/repo", name: sessionId, taskState: "READY", processState: "LIVE", outcome: "NONE",
    activity: { kind: "idle", summary: "Idle", updatedAt: at },
    ownership: { kind: "managed", runId: `run-${sessionId}`, process: identity, acquiredAt: at, heartbeatAt: at },
    latestRunId: `run-${sessionId}`, createdAt: at, updatedAt: at,
  });
  // No `cliVersion` and no `proto`, exactly like the operator's live workers: adoption must not
  // depend on them. Their UNKNOWN release status is pinned in runtime/daemon.integration.test.mjs.
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, identity, piChildIdentity }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({
    root,
    inspect: async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : pid === identity.pid ? identity : piChildIdentity,
  });
  runtimes.push(runtime);
  return { registry, runtime, sessionId };
}

/** Attach one worker socket that forwards raw Pi events through the real event mapping. */
async function attachWorker(runtime, sessionId) {
  const encoder = createJsonlEncoder({ maxBytes: 65536 });
  const decoder = createJsonlDecoder({ maxBytes: 65536 });
  const socket = net.createConnection(runtime.socketPath);
  sockets.push(socket);
  socket.on("error", () => {});
  /** @type {any[]} */
  const received = [];
  socket.on("data", (chunk) => { for (const frame of decoder.push(chunk)) received.push(frame); });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(encoder.encode({ version: 1, token: runtime.token, role: "worker" }));
  await vi.waitFor(() => expect(received.some((frame) => frame?.kind === "authenticated")).toBe(true));
  socket.write(encoder.encode({ version: 1, type: "worker_ready", token: "throbber-token", sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, worker: identity, piChild: piChildIdentity }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    /** Send one Pi RPC event exactly as the installed worker would. @param {Record<string, unknown>} event */
    emitPiEvent(event) {
      const stateEvent = sessionEventForPiEvent(event);
      if (stateEvent === undefined) return false;
      socket.write(encoder.encode({ version: 1, type: "worker_event", token: "throbber-token", sessionId, event: stateEvent }));
      return true;
    },
  };
}

/** Mount one dashboard against the daemon with a host that repaints on every render request. */
async function mountDashboard(runtime, clientId) {
  const client = createDaemonClient({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 1024 * 1024, clientId });
  clients.push(client);
  const backend = createDaemonDashboardBackend({ client, clientId, preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
  /** @type {string[]} */
  const rows = [];
  /** @type {any} */
  let controller;
  controller = new DashboardController({
    backend,
    openViewer: async () => {},
    clientId, sourceSessionId: `dashboard-${clientId}`,
    launchDefaults: { cwd: "/repo", model: { provider: "anthropic", id: "claude" }, name: "task" },
    requestRender: () => { rows.push(stripVTControlCharacters(controller.render(WIDTH, HEIGHT)[FIRST_ROW])); },
  });
  await controller.open();
  return { controller, rows };
}

/** @param {string} row */
function glyphOf(row) {
  return [...row].find((character) => FRAMES.has(character));
}

it("moves the throbber in the mounted list while Pi is running a turn", async () => {
  const { registry, runtime, sessionId } = await daemonWithLiveSession("throbber");
  // Recovery blocks until the recorded worker reconnects, so the worker socket comes first.
  const worker = await attachWorker(runtime, sessionId);
  await runtime.ready;
  const { controller, rows } = await mountDashboard(runtime, "throbber-frontend");

  expect(glyphOf(rows.at(-1) ?? "")).toBeUndefined();

  // One real Pi run: the model starts, calls a tool, and keeps working across the turn boundary.
  expect(worker.emitPiEvent({ type: "agent_start" })).toBe(true);
  await vi.waitFor(async () => expect(await registry.get(sessionId)).toMatchObject({ taskState: "WORKING" }));
  await vi.waitFor(() => expect(rows.some((row) => row.includes("WORKING"))).toBe(true));

  worker.emitPiEvent({ type: "tool_execution_start", toolName: "bash" });
  worker.emitPiEvent({ type: "turn_end", message: {} });
  worker.emitPiEvent({ type: "turn_start" });
  // A recorded run fires bursts of these between turn_start and turn_end; none of them ends the run.
  for (let index = 0; index < 20; index += 1) expect(worker.emitPiEvent({ type: "extension_ui_request", method: "setWidget", widgetKey: "monitor-list" })).toBe(false);

  rows.length = 0;
  await new Promise((resolve) => setTimeout(resolve, SPINNER_INTERVAL_MS * 5));
  const glyphs = rows.filter((row) => row.includes("WORKING")).map((row) => glyphOf(row));
  expect(glyphs.length).toBeGreaterThan(1);
  expect(glyphs.every((glyph) => glyph !== undefined)).toBe(true);
  expect(new Set(glyphs).size).toBeGreaterThan(1);

  worker.emitPiEvent({ type: "agent_settled" });
  await vi.waitFor(async () => expect(await registry.get(sessionId)).toMatchObject({ taskState: "READY" }));
  await vi.waitFor(() => expect(rows.at(-1)).not.toContain("WORKING"));
  const settled = rows.length;
  await new Promise((resolve) => setTimeout(resolve, SPINNER_INTERVAL_MS * 4));
  expect(rows.length).toBe(settled);
  expect(glyphOf(rows.at(-1) ?? "")).toBeUndefined();

  await controller.close();
});

it("shows the throbber for a turn that started while no frontend was attached", async () => {
  const { registry, runtime, sessionId } = await daemonWithLiveSession("detached");
  const worker = await attachWorker(runtime, sessionId);
  await runtime.ready;
  const first = await mountDashboard(runtime, "detached-frontend-a");
  await first.controller.close();

  worker.emitPiEvent({ type: "agent_start" });
  worker.emitPiEvent({ type: "turn_start" });
  await vi.waitFor(async () => expect(await registry.get(sessionId)).toMatchObject({ taskState: "WORKING" }));

  const second = await mountDashboard(runtime, "detached-frontend-b");
  await vi.waitFor(() => expect(second.rows.at(-1)).toContain("WORKING"));
  second.rows.length = 0;
  await new Promise((resolve) => setTimeout(resolve, SPINNER_INTERVAL_MS * 5));
  expect(new Set(second.rows.map((row) => glyphOf(row))).size).toBeGreaterThan(1);

  worker.emitPiEvent({ type: "agent_settled" });
  await vi.waitFor(() => expect(second.rows.at(-1)).not.toContain("WORKING"));
  await second.controller.close();
});
