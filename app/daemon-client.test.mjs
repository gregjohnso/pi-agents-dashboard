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

const emptyState = { kind: "state", sessions: [], cursor: { daemonEpoch: "epoch-1", sequence: "0" } };
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

  it("notifies a list subscriber for every invalidation without holding one of them", async () => {
    const socketPath = await socketPathIn("client-invalidation-");
    /** @type {any[]} */
    const payloads = [];
    const server = await daemonServer(socketPath, ({ request: incoming, reply }) => {
      if (incoming.op !== "subscribe_list_changes") return;
      payloads.push(incoming.payload);
      reply({ kind: "list_subscribed" });
    });
    const client = startClient({ socketPath, reconnectDelayMs: 1 });
    let notifications = 0;
    const unsubscribe = await client.subscribeListChanges(() => { notifications += 1; });
    expect(payloads).toEqual([{}]);
    const before = notifications;
    for (let index = 0; index < 5_000; index += 1) server.socket?.write(encodeJsonl({ version: 1, kind: "list_changed" }));
    await waitFor(() => notifications - before === 5_000);
    unsubscribe();
    server.socket?.write(encodeJsonl({ version: 1, kind: "list_changed" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications - before).toBe(5_000);
  });

  // A change published while the socket was down is invisible, so reconnecting is itself a change.
  it("resubscribes and reports a change after a reconnect", async () => {
    const socketPath = await socketPathIn("client-resubscribe-");
    let subscriptions = 0;
    const server = await daemonServer(socketPath, ({ request: incoming, reply }) => {
      if (incoming.op !== "subscribe_list_changes") return;
      subscriptions += 1;
      reply({ kind: "list_subscribed" });
    });
    const client = startClient({ socketPath, reconnectDelayMs: 1 });
    let notifications = 0;
    await client.subscribeListChanges(() => { notifications += 1; });
    await waitFor(() => subscriptions === 1);
    const before = notifications;
    server.socket?.destroy();
    await waitFor(() => subscriptions === 2);
    await waitFor(() => notifications > before);
  });

  // Operator-visible failure: an old daemon has no list-invalidation operation, and a subscription
  // that failed silently left the list frozen on rows it read once and never refreshed.
  it("fails the list subscription when the daemon refuses the operation", async () => {
    const socketPath = await socketPathIn("client-old-daemon-");
    await daemonServer(socketPath, ({ socket, request: incoming }) => {
      socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: false, error: { code: "INVALID_REQUEST", message: "Invalid client request", retryable: false } }));
    });
    const client = startClient({ socketPath, reconnect: false });
    await expect(within(client.subscribeListChanges(() => {}))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
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

  // A broadcast frame belongs to no request, so a frame this release cannot read means the daemon
  // is publishing something the list does not understand. It stays fatal, and the reconnect
  // resubscribes; the retired persisted list event is exactly such a frame.
  it("keeps a broadcast frame it cannot read fatal, resubscribes, and retains the request it interrupted", async () => {
    const socketPath = await socketPathIn("client-malformed-broadcast-");
    const retiredEvent = { version: 1, cursor: { daemonEpoch: "epoch-1", sequence: "1" }, occurredAt: "2026-01-01T00:00:00.000Z", kind: "session_changed", payload: {} };
    const server = await daemonServer(socketPath, ({ socket, request: incoming, connection, reply }) => {
      if (incoming.op !== "subscribe_list_changes") {
        if (connection === 2) reply(emptyState);
        return;
      }
      reply({ kind: "list_subscribed" });
      socket.write(encodeJsonl(connection === 1 ? retiredEvent : { version: 1, kind: "list_changed" }));
    });
    const client = startClient({ socketPath, maxBytes: 4096, reconnectDelayMs: 1 });
    /** @type {any[]} */
    const fatalErrors = [];
    client.onFatalError?.((error) => fatalErrors.push(error));
    let notifications = 0;
    const interrupted = client.request(request);
    await client.subscribeListChanges(() => { notifications += 1; });
    await expect(within(interrupted)).resolves.toMatchObject({ ok: true, result: emptyState });
    await waitFor(() => notifications > 0);
    expect(server.connections).toBe(2);
    expect(fatalErrors).toEqual([expect.objectContaining({ code: "MALFORMED_FRAME" })]);
  });

  it("resumes a viewer subscription from the applied cursor, not the delivered one", async () => {
    const socketPath = await socketPathIn("viewer-resume-");
    /** @type {any[]} */
    const subscriptions = [];
    const zero = { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: "0" };
    const one = { ...zero, sequence: "1" };
    const event = { version: 1, sessionId: "session-1", eventId: "event-1", cursor: one, timestamp: "2026-08-25T00:00:00.000Z", payload: { kind: "user_message", itemId: "user-1", content: [{ type: "text", text: "hello" }] } };
    const server = await daemonServer(socketPath, ({ socket, request: incoming, reply }) => {
      if (incoming.op !== "subscribe_viewer") return;
      subscriptions.push(incoming.payload.after);
      reply({ kind: "viewer_subscribed", cursor: incoming.payload.after });
      if (subscriptions.length === 1) socket.write(encodeJsonl(event));
    });
    const client = startClient({ socketPath, reconnectDelayMs: 1, maxBytes: 4096 });
    const subscription = client.subscribeViewer("session-1", zero)[Symbol.asyncIterator]();
    await waitFor(() => subscriptions.length === 1);
    await expect(within(subscription.next())).resolves.toMatchObject({ value: { eventId: "event-1" }, done: false });

    // Handed over is not applied: a drop here has to replay the event rather than skip it.
    server.socket?.destroy();
    await waitFor(() => subscriptions.length === 2);
    expect(subscriptions[1]).toEqual(zero);

    subscription.applied(one);
    server.socket?.destroy();
    await waitFor(() => subscriptions.length === 3);
    expect(subscriptions[2]).toEqual(one);
    await subscription.return?.();
  });

  it("gets viewer snapshots and subscribes by session cursor", async () => {
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
    const server = await daemonServer(socketPath, ({ reply }) => reply({ kind: "list_subscribed" }));
    const client = startClient({ socketPath, reconnectDelayMs: 1 });
    /** @type {boolean[]} */
    const connection = [];
    client.onConnectionChange((status) => connection.push(status.connected));
    const unsubscribe = await client.subscribeListChanges(() => {});
    await waitFor(() => connection.length === 1);

    server.socket?.destroy();
    await waitFor(() => connection.length === 3);
    expect(connection).toEqual([true, false, true]);
    unsubscribe();
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
