import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonlDecoder, encodeJsonl } from "../runtime/jsonl.mjs";
import { createDaemonClient } from "./daemon-client.mjs";

/** @type {Array<() => Promise<unknown> | unknown>} */
const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

/** One Unix socket path in a throwaway directory. @param {string} prefix */
async function socketPathIn(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "control.sock");
}

/**
 * Authenticate every connection, then hand each request frame to `respond`.
 * @param {string} socketPath
 * @param {(exchange: { socket: net.Socket, request: any, connection: number, requests: number, reply: (result: any) => void }) => void} respond
 */
async function daemonServer(socketPath, respond) {
  const state = { requests: 0, connections: 0, /** @type {net.Socket | undefined} */ socket: undefined, /** @type {net.Socket[]} */ sockets: [] };
  const server = net.createServer((socket) => {
    state.connections += 1;
    state.socket = socket;
    state.sockets.push(socket);
    const connection = state.connections;
    const decoder = createJsonlDecoder({ maxBytes: 8192 });
    let authenticated = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const request of decoder.push(chunk)) {
        if (!authenticated) {
          authenticated = true;
          socket.write(encodeJsonl({ version: 1, kind: "authenticated" }));
          continue;
        }
        state.requests += 1;
        respond({ socket, request, connection, requests: state.requests, reply: (result) => socket.write(encodeJsonl({ version: 1, requestId: request.requestId, ok: true, result })) });
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  // close() waits for live connections, so drop them first: a client closed after the server would hang cleanup.
  cleanups.push(() => new Promise((resolve) => {
    for (const socket of state.sockets) socket.destroy();
    server.close(() => resolve(undefined));
  }));
  return state;
}

/** @param {any} options */
function startClient(options) {
  const client = createDaemonClient({ token: "secret", clientId: "client-1", maxBytes: 1024, ...options });
  cleanups.push(() => client.close());
  return client;
}

const emptyState = { kind: "state", sessions: [] };
const request = { version: 1, clientId: "client-1", requestId: "exact-request-id", op: "get_state", payload: {} };

/** @param {() => boolean} predicate */
async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** @param {Promise<any>} promise */
async function within(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for protocol recovery")), 2_000)),
  ]);
}

describe("daemon client", () => {
  it("authenticates and correlates responses by exact request ID", async () => {
    const socketPath = await socketPathIn("client-");
    await daemonServer(socketPath, ({ reply }) => reply(emptyState));
    const client = startClient({ socketPath });
    await client.connect();
    expect(await client.request(request)).toMatchObject({ requestId: "exact-request-id", ok: true });
  });

  it("reconnects and resends the same request after disconnect without worker-side cancellation", async () => {
    const socketPath = await socketPathIn("client-");
    const server = await daemonServer(socketPath, ({ socket, requests, reply }) => requests === 1 ? socket.destroy() : reply(emptyState));
    const client = startClient({ socketPath, reconnectDelayMs: 1 });
    expect(await client.request(request)).toMatchObject({ requestId: "exact-request-id", ok: true });
    expect(server.requests).toBe(2);
  });

  it("does not replay a transactional request after its authenticated socket disconnects", async () => {
    const socketPath = await socketPathIn("client-");
    const server = await daemonServer(socketPath, ({ socket, requests, reply }) => requests === 1 ? socket.destroy() : reply(emptyState));
    const client = startClient({ socketPath, reconnect: false });
    await expect(within(client.request(request))).rejects.toMatchObject({ code: "CONNECTION_CLOSED", submitted: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.requests).toBe(1);
  });

  it("retains an unresolved request while reconnect attempts fail until the daemon starts", async () => {
    const socketPath = await socketPathIn("client-late-");
    const client = startClient({ socketPath, reconnectDelayMs: 2 });
    const response = client.request(request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await daemonServer(socketPath, ({ reply }) => reply(emptyState));
    await expect(response).resolves.toMatchObject({ requestId: request.requestId, ok: true });
  });

  it("reconnects subscriptions from the acknowledged cursor and wires successful ack responses", async () => {
    const socketPath = await socketPathIn("client-ack-");
    /** @type {any[]} */
    const subscriptions = [];
    const server = await daemonServer(socketPath, ({ request: incoming, reply }) => {
      if (incoming.op === "subscribe") {
        subscriptions.push(incoming.payload.after);
        reply({ kind: "subscribed", cursor: incoming.payload.after });
      } else if (incoming.op === "ack") reply({ kind: "acknowledged", cursor: incoming.payload.cursor });
    });
    const client = startClient({ socketPath, reconnectDelayMs: 1 });
    const zero = { daemonEpoch: "epoch-1", sequence: "0" };
    const one = { daemonEpoch: "epoch-1", sequence: "1" };
    const iterator = client.subscribe(zero)[Symbol.asyncIterator]();
    await waitFor(() => subscriptions.length === 1);
    const pendingEvent = iterator.next();
    server.socket?.write(encodeJsonl({ version: 1, cursor: one, occurredAt: "2026-01-01T00:00:00.000Z", kind: "attachment_changed", payload: { sessionId: "s", clientId: "client-1", role: "observer", attached: true } }));
    await expect(pendingEvent).resolves.toMatchObject({ value: { cursor: one }, done: false });
    server.socket?.destroy();
    await waitFor(() => subscriptions.length === 2);
    expect(subscriptions[1]).toEqual(zero);
    await client.request({ version: 1, clientId: "client-1", requestId: "ack-1", op: "ack", payload: { cursor: one } });
    server.socket?.destroy();
    await waitFor(() => subscriptions.length === 3);
    expect(subscriptions[2]).toEqual(one);
    await iterator.return?.();
  });

  // Operator-visible failure: a two-field response skew froze the dashboard. The unparseable frame
  // destroyed the connection, and every reconnect resent the request that provoked it.
  it("rejects only the request whose response cannot be parsed and keeps the connection", async () => {
    const malformed = { kind: "state", sessions: "invalid" };
    const socketPath = await socketPathIn("client-malformed-response-");
    const server = await daemonServer(socketPath, ({ socket, request: incoming, reply }) => {
      if (incoming.requestId === "skewed-request") socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: malformed }));
      else reply(emptyState);
    });
    const client = startClient({ socketPath, reconnectDelayMs: 1 });
    /** @type {any[]} */
    const fatalErrors = [];
    client.onFatalError?.((error) => fatalErrors.push(error));
    await expect(within(client.request({ ...request, requestId: "skewed-request" }))).rejects.toMatchObject({ code: "MALFORMED_RESPONSE", submitted: true });
    await expect(within(client.request({ ...request, requestId: "sound-request" }))).resolves.toMatchObject({ ok: true, result: emptyState });
    expect({ connections: server.connections, requests: server.requests }).toEqual({ connections: 1, requests: 2 });
    expect(fatalErrors).toEqual([]);
  });

  // Operator-visible failure: one unparseable response frame produced 6676 reconnects at about 222
  // per second against the live daemon, because reconnect resent every pending request.
  it("does not reconnect and resend a request whose response cannot be parsed", async () => {
    const socketPath = await socketPathIn("client-response-storm-");
    const server = await daemonServer(socketPath, ({ socket, request: incoming }) => {
      socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "state", sessions: "invalid" } }));
    });
    const client = startClient({ socketPath, reconnectDelayMs: 1 });
    await expect(within(client.request(request))).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect({ connections: server.connections, requests: server.requests }).toEqual({ connections: 1, requests: 1 });
  });

  // A frame no request can own tells the client nothing about what to retry, so it stays fatal.
  it("keeps an unparseable frame that belongs to no request fatal without failing a live request", async () => {
    const socketPath = await socketPathIn("client-unattributed-");
    const server = await daemonServer(socketPath, ({ socket, connection, reply }) => {
      if (connection === 1) socket.write(encodeJsonl({ version: 1, requestId: "belongs-to-nobody", ok: true, result: { kind: "state", sessions: "invalid" } }));
      else reply(emptyState);
    });
    const client = startClient({ socketPath, reconnectDelayMs: 1 });
    /** @type {any[]} */
    const fatalErrors = [];
    client.onFatalError?.((error) => fatalErrors.push(error));
    await expect(within(client.request(request))).resolves.toMatchObject({ ok: true, result: emptyState });
    expect(server.connections).toBe(2);
    expect(fatalErrors).toEqual([expect.objectContaining({ code: "MALFORMED_FRAME" })]);
  });

  it("coalesces superseded session updates instead of overflowing a slow list consumer", async () => {
    const socketPath = await socketPathIn("client-coalesce-");
    const session = (sessionId, sequence) => ({ schemaVersion: 1, revision: sequence, sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, canonicalSessionFile: `/sessions/${sessionId}.jsonl`, cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "assistant_streaming", summary: `chunk ${sequence}`, updatedAt: "2026-01-01T00:00:00.000Z" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const event = (sessionId, sequence) => ({ version: 1, cursor: { daemonEpoch: "epoch-1", sequence: String(sequence) }, occurredAt: "2026-01-01T00:00:00.000Z", kind: "session_changed", payload: { session: session(sessionId, sequence) } });
    await daemonServer(socketPath, ({ socket, reply }) => {
      reply({ kind: "subscribed", cursor: { daemonEpoch: "epoch-1", sequence: "0" } });
      for (let sequence = 1; sequence <= 12; sequence += 1) socket.write(encodeJsonl(event("streaming", sequence)));
      socket.write(encodeJsonl(event("other", 13)));
    });
    const client = startClient({ socketPath, maxBytes: 8192, reconnectDelayMs: 1, subscriberLimit: 4, reconnect: false });
    const iterator = client.subscribe({ daemonEpoch: "epoch-1", sequence: "0" })[Symbol.asyncIterator]();
    const first = await within(iterator.next());
    expect(first.value.payload.session.sessionId).toBe("streaming");
    const second = await within(iterator.next());
    expect(second.value.cursor.sequence).toBe("12");
    const third = await within(iterator.next());
    expect(third.value.payload.session.sessionId).toBe("other");
    await iterator.return?.();
  });

  // Operator-visible failure: the dashboard exited with "SUBSCRIBER_OVERFLOW: Client subscriber
  // exceeded its bounded queue" whenever the daemon replayed more events than the queue holds.
  it("asks a list subscriber that fell behind to resynchronize instead of ending it", async () => {
    const socketPath = await socketPathIn("client-overflow-");
    const session = (sessionId) => ({ schemaVersion: 1, revision: 1, sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, canonicalSessionFile: `/sessions/${sessionId}.jsonl`, cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "assistant_final", summary: sessionId, updatedAt: "2026-01-01T00:00:00.000Z" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const event = (sequence) => ({ version: 1, cursor: { daemonEpoch: "epoch-1", sequence: String(sequence) }, occurredAt: "2026-01-01T00:00:00.000Z", kind: "session_changed", payload: { session: session(`session-${sequence}`) } });
    const server = await daemonServer(socketPath, ({ socket, reply }) => {
      reply({ kind: "subscribed", cursor: { daemonEpoch: "epoch-1", sequence: "0" } });
      for (let sequence = 1; sequence <= 13; sequence += 1) socket.write(encodeJsonl(event(sequence)));
    });
    const client = startClient({ socketPath, maxBytes: 8192, reconnectDelayMs: 1, subscriberLimit: 4, reconnect: false });
    const iterator = client.subscribe({ daemonEpoch: "epoch-1", sequence: "0" })[Symbol.asyncIterator]();
    /** @type {any[]} */
    const delivered = [];
    for (;;) {
      const next = await within(iterator.next());
      expect(next.done).toBe(false);
      delivered.push(next.value);
      if (next.value.kind === "resynchronize") break;
    }
    // The marker names the newest position the client saw, so the consumer can refetch a snapshot
    // and skip everything the snapshot already contains.
    expect(delivered.at(-1)).toEqual({ kind: "resynchronize", cursor: { daemonEpoch: "epoch-1", sequence: "13" } });
    expect(delivered.filter((value) => value.kind === "session_changed").length).toBeLessThan(13);

    server.socket?.write(encodeJsonl(event(14)));
    await expect(within(iterator.next())).resolves.toMatchObject({ value: { cursor: { sequence: "14" } }, done: false });
    await iterator.return?.();
  });

  // A broadcast frame belongs to no request, so dropping it would leave a gap in an ordered stream
  // that no consumer can name or refetch. It stays fatal, and the reconnect resubscribes.
  it("keeps a malformed event fatal, resubscribes, and retains the request it interrupted", async () => {
    const socketPath = await socketPathIn("client-malformed-event-");
    const executable = { realpath: "/installed/pi", device: "1", inode: "2", size: 3, modifiedTimeNs: "4" };
    const identity = { pid: 10, startIdentity: "start", processGroupId: 10 };
    const runtime = { executable, piVersion: "1.0.0", capabilities: { executable, reportedVersion: "1.0.0", rpcMode: true, jsonl: true, commands: ["get_state", "prompt", "follow_up", "steer", "abort", "extension_ui_response"], events: ["required_live_events"], missingRequired: [] }, rpcAdapterVersion: 1, viewerProtocolVersion: 1, supervisor: identity, piChild: identity };
    const session = { schemaVersion: 1, revision: 1, sessionId: "s", sessionFile: "/sessions/s.jsonl", canonicalSessionFile: "/sessions/s.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "launching", summary: "Starting", updatedAt: "2026-01-01T00:00:00.000Z" }, runtime, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const validEvent = { version: 1, cursor: { daemonEpoch: "epoch-1", sequence: "1" }, occurredAt: "2026-01-01T00:00:00.000Z", kind: "session_changed", payload: { session } };
    const server = await daemonServer(socketPath, ({ socket, request: incoming, connection, reply }) => {
      if (incoming.op !== "subscribe") {
        if (connection === 2) reply(emptyState);
        return;
      }
      reply({ kind: "subscribed", cursor: { daemonEpoch: "epoch-1", sequence: "0" } });
      if (connection === 1) socket.write(encodeJsonl({ ...validEvent, cursor: { daemonEpoch: "epoch-1", sequence: 1 } }));
      else socket.write(encodeJsonl(validEvent));
    });
    const client = startClient({ socketPath, maxBytes: 4096, reconnectDelayMs: 1 });
    /** @type {any[]} */
    const fatalErrors = [];
    client.onFatalError?.((error) => fatalErrors.push(error));
    const interrupted = client.request(request);
    const iterator = client.subscribe({ daemonEpoch: "epoch-1", sequence: "0" })[Symbol.asyncIterator]();
    await expect(within(iterator.next())).resolves.toMatchObject({ value: validEvent, done: false });
    await expect(within(interrupted)).resolves.toMatchObject({ ok: true, result: emptyState });
    expect(server.connections).toBe(2);
    expect(fatalErrors).toEqual([expect.objectContaining({ code: "MALFORMED_FRAME" })]);
    await iterator.return?.();
  });

  it("gets viewer snapshots, subscribes by session cursor, and acknowledges only after consumer processing", async () => {
    const socketPath = await socketPathIn("viewer-client-");
    /** @type {string[]} */
    const operations = [];
    const zero = { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: "0" };
    const one = { ...zero, sequence: "1" };
    const activity = { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "source", startedAt: "2026-08-25T00:00:00.000Z" };
    const snapshot = { version: 1, sessionId: "session-1", registryRevision: 1, cursor: zero, runtime: null, role: "observer", taskState: "READY", processState: "SLEEPING", outcome: "NONE", activity, model: null, thinkingLevel: null, items: [], tools: [], pendingUi: [], errors: [] };
    const event = { version: 1, sessionId: "session-1", eventId: "event-1", cursor: one, timestamp: "2026-08-25T00:00:00.000Z", payload: { kind: "user_message", itemId: "user-1", content: [{ type: "text", text: "hello" }] } };
    await daemonServer(socketPath, ({ socket, request: incoming, reply }) => {
      operations.push(incoming.op);
      if (incoming.op === "get_viewer_snapshot") reply({ kind: "viewer_snapshot", snapshot });
      else if (incoming.op === "subscribe_viewer") {
        reply({ kind: "viewer_subscribed", cursor: zero });
        socket.write(encodeJsonl(event));
      } else if (incoming.op === "ack_viewer") reply({ kind: "viewer_acknowledged", cursor: incoming.payload.cursor });
    });
    const client = startClient({ socketPath, maxBytes: 4096 });
    await expect(client.getViewerSnapshot("session-1")).resolves.toEqual(snapshot);
    const iterator = client.subscribeViewer("session-1", zero)[Symbol.asyncIterator]();
    const delivered = await within(iterator.next());
    expect(delivered).toEqual({ value: event, done: false });
    expect(operations).not.toContain("ack_viewer");
    await expect(client.ackViewer(one)).resolves.toEqual(one);
    expect(operations).toEqual(["get_viewer_snapshot", "subscribe_viewer", "ack_viewer"]);
    await iterator.return?.();
  });

  it("reports the daemon going away and coming back", async () => {
    const socketPath = await socketPathIn("client-connection-");
    const server = await daemonServer(socketPath, ({ reply }) => reply({ kind: "subscribed", cursor: { daemonEpoch: "epoch-1", sequence: "0" } }));
    const client = startClient({ socketPath, reconnectDelayMs: 1 });
    /** @type {boolean[]} */
    const connection = [];
    client.onConnectionChange((status) => connection.push(status.connected));
    const iterator = client.subscribe()[Symbol.asyncIterator]();
    await waitFor(() => connection.length === 1);

    server.socket?.destroy();
    await waitFor(() => connection.length === 3);
    expect(connection).toEqual([true, false, true]);
    await iterator.return?.();
  });

  it("forgets old completed responses instead of retaining every one for the life of the dashboard", async () => {
    const socketPath = await socketPathIn("client-seen-");
    const server = await daemonServer(socketPath, ({ reply }) => reply(emptyState));
    const client = startClient({ socketPath });
    const state = (/** @type {string} */ requestId) => ({ version: 1, clientId: "client-1", requestId, op: "get_state", payload: {} });
    for (let index = 0; index < 300; index += 1) await client.request(state(`request-${index}`));
    const answered = server.requests;

    await client.request(state("request-299"));
    expect(server.requests).toBe(answered);
    await client.request(state("request-0"));
    expect(server.requests).toBe(answered + 1);
  });

  it("forgets retained snapshots once they outgrow the client's response budget", async () => {
    const socketPath = await socketPathIn("client-seen-bytes-");
    const cursor = { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: "0" };
    const activity = { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "source", startedAt: "2026-08-25T00:00:00.000Z" };
    const snapshot = { version: 1, sessionId: "session-1", registryRevision: 1, cursor, runtime: null, role: "observer", taskState: "READY", processState: "SLEEPING", outcome: "NONE", activity, model: null, thinkingLevel: null, items: [{ kind: "assistant_message", itemId: "answer", content: Array.from({ length: 10 }, () => ({ type: "text", text: "x".repeat(60_000) })) }], tools: [], pendingUi: [], errors: [] };
    const server = await daemonServer(socketPath, ({ reply }) => reply({ kind: "viewer_snapshot", snapshot }));
    const client = startClient({ socketPath, maxBytes: 1024 * 1024 });
    const read = (/** @type {string} */ requestId) => client.request({ version: 1, clientId: "client-1", requestId, op: "get_viewer_snapshot", payload: { sessionId: "session-1" } });
    for (let index = 0; index < 8; index += 1) await read(`snapshot-${index}`);
    const answered = server.requests;

    await read("snapshot-7");
    expect(server.requests).toBe(answered);
    await read("snapshot-0");
    expect(server.requests).toBe(answered + 1);
  });

  it("sets a session color without a revision precondition", async () => {
    const socketPath = await socketPathIn("client-color-");
    /** @type {any[]} */
    const payloads = [];
    await daemonServer(socketPath, ({ request: incoming, reply }) => {
      payloads.push({ op: incoming.op, payload: incoming.payload });
      reply({ kind: "session_colored", sessionId: incoming.payload.sessionId, revision: payloads.length, color: incoming.payload.color });
    });
    const client = startClient({ socketPath, maxBytes: 4096 });
    await expect(client.setSessionColor("session-1", "amber")).resolves.toMatchObject({ kind: "session_colored", color: "amber", revision: 1 });
    await expect(client.setSessionColor("session-1", null)).resolves.toMatchObject({ color: null });
    expect(payloads).toEqual([
      { op: "set_session_color", payload: { sessionId: "session-1", color: "amber" } },
      { op: "set_session_color", payload: { sessionId: "session-1", color: null } },
    ]);
    await expect(client.setSessionColor("", "amber")).rejects.toThrow(/sessionId/iu);
  });

  it("reads the installed Pi's model catalog and keeps the daemon's own refusal code", async () => {
    const socketPath = await socketPathIn("client-models-");
    const models = [{ provider: "anthropic", id: "claude-opus-4", thinking: true }, { provider: "google", id: "gemini-3-flash", thinking: false }];
    /** @type {any[]} */
    const payloads = [];
    await daemonServer(socketPath, ({ socket, request: incoming, reply }) => {
      payloads.push({ op: incoming.op, payload: incoming.payload });
      if (payloads.length === 1) reply({ kind: "models", models });
      else socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: false, error: { code: "MODEL_CATALOG_FAILED", message: "Listing Pi models exited 1", retryable: false } }));
    });
    const client = startClient({ socketPath, maxBytes: 8192 });
    await expect(client.getModels()).resolves.toEqual(models);
    await expect(client.getModels()).rejects.toMatchObject({ code: "MODEL_CATALOG_FAILED", message: "Listing Pi models exited 1" });
    expect(payloads.map((entry) => entry.op)).toEqual(["get_models", "get_models"]);
    expect(payloads[0].payload).toEqual({});
  });

});
