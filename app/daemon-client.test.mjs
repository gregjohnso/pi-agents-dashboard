import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonlDecoder, encodeJsonl } from "../runtime/jsonl.mjs";
import { CLIENT_PROTOCOL } from "../shared/contracts.mjs";
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
 *
 * `refuse` is not decoration: a double that can only accept cannot reproduce a daemon that turns an
 * operation down, and that is how a refused viewer subscription reached production unnoticed.
 * @param {string} socketPath
 * @param {(exchange: { socket: net.Socket, request: any, connection: number, requests: number, reply: (result: any) => void, refuse: (error: { code: string, message: string, retryable?: boolean }) => void }) => void} respond
 */
async function daemonServer(socketPath, respond) {
  const state = { requests: 0, connections: 0, /** @type {any[]} */ authentications: [], /** @type {net.Socket | undefined} */ socket: undefined, /** @type {net.Socket[]} */ sockets: [] };
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
          state.authentications.push(request);
          socket.write(encodeJsonl({ version: 1, kind: "authenticated" }));
          continue;
        }
        state.requests += 1;
        respond({
          socket, request, connection, requests: state.requests,
          reply: (result) => socket.write(encodeJsonl({ version: 1, requestId: request.requestId, ok: true, result })),
          refuse: (error) => socket.write(encodeJsonl({ version: 1, requestId: request.requestId, ok: false, error: { retryable: false, ...error } })),
        });
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

  // The daemon binds this connection's open sessions to the attachId, so three dashboards of one
  // installation are three peers rather than one identity racing itself.
  it("declares this dashboard process in the authentication frame, and omits it when there is none", async () => {
    const socketPath = await socketPathIn("client-");
    const server = await daemonServer(socketPath, ({ reply }) => reply(emptyState));
    const withAttachId = startClient({ socketPath, attachId: "attach-one" });
    await withAttachId.connect();
    const withoutAttachId = startClient({ socketPath, clientId: "client-1" });
    await withoutAttachId.connect();
    expect(server.authentications).toEqual([
      { version: 1, token: "secret", clientProtocol: CLIENT_PROTOCOL, attachId: "attach-one" },
      { version: 1, token: "secret", clientProtocol: CLIENT_PROTOCOL },
    ]);
    // A transaction client is another connection of the same dashboard process, not another process.
    expect(withAttachId.createTransactionClient).toBeTypeOf("function");
    expect(() => startClient({ socketPath, attachId: "" })).toThrow(/attachId/u);
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

  const viewerCursor = { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: "0" };
  const viewerSnapshot = {
    version: 1, sessionId: "session-1", registryRevision: 1, cursor: viewerCursor, runtime: null,
    taskState: "READY", processState: "SLEEPING", outcome: "NONE",
    activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "source", startedAt: "2026-08-25T00:00:00.000Z" },
    model: null, thinkingLevel: null, items: [], tools: [], pendingUi: [], errors: [],
  };
  const viewerEvent = { version: 1, sessionId: "session-1", eventId: "event-1", cursor: { ...viewerCursor, sequence: "1" }, timestamp: "2026-08-25T00:00:00.000Z", payload: { kind: "user_message", itemId: "user-1", content: [{ type: "text", text: "hello" }] } };

  // The subscriber is registered before the request goes out, so an event the daemon writes in the
  // same chunk as its answer is queued rather than dropped. Nothing retains it to replay.
  it("opens one subscription that carries its own snapshot and queues events behind it", async () => {
    const socketPath = await socketPathIn("viewer-client-");
    /** @type {string[]} */
    const operations = [];
    await daemonServer(socketPath, ({ socket, request: incoming, reply }) => {
      operations.push(incoming.op);
      if (incoming.op !== "subscribe_viewer") return;
      expect(incoming.payload).toEqual({ sessionId: "session-1" });
      socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "viewer_subscribed", cursor: viewerCursor, snapshot: viewerSnapshot } }) + encodeJsonl(viewerEvent));
    });
    const client = startClient({ socketPath, maxBytes: 4096 });
    const subscription = client.subscribeViewer("session-1");
    await expect(within(subscription.established)).resolves.toEqual(viewerSnapshot);
    await expect(within(subscription.next())).resolves.toEqual({ value: viewerEvent, done: false });
    expect(/** @type {Record<string, unknown>} */ (client).getViewerSnapshot).toBeUndefined();
    expect(/** @type {Record<string, unknown>} */ (client).ackViewer).toBeUndefined();
    expect(operations).toEqual(["subscribe_viewer"]);
    await subscription.return?.();
  });

  // Operator-visible failure: a viewer whose subscription the daemon refused sat on a frozen
  // transcript while this client still reported the connection healthy. The list stopped doing this
  // when it started awaiting its own subscription; the viewer kept sending one and reading nothing back.
  it("ends a viewer subscription, and its snapshot, with the daemon's refusal", async () => {
    const socketPath = await socketPathIn("viewer-refused-");
    await daemonServer(socketPath, ({ request: incoming, refuse }) => {
      if (incoming.op === "subscribe_viewer") refuse({ code: "SESSION_NOT_FOUND", message: "Viewer session does not exist" });
    });
    const client = startClient({ socketPath, reconnectDelayMs: 1, maxBytes: 4096 });
    const subscription = client.subscribeViewer("session-1");
    const reading = subscription.next().then(() => "the refused subscription delivered an event", (/** @type {unknown} */ error) => error);
    // The reader was already waiting, so a refusal that only records itself still hangs it forever.
    await expect(within(reading)).resolves.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(within(subscription.established)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(within(subscription.next())).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  // A viewer subscription dies with its connection and is never reopened here: only the reader that
  // builds a transcript from a fresh snapshot can use a new one, and the daemon answers every
  // subscription with one.
  it("ends a viewer subscription when its connection drops instead of resubscribing", async () => {
    const socketPath = await socketPathIn("viewer-dropped-");
    /** @type {number[]} */
    const subscriptions = [];
    const server = await daemonServer(socketPath, ({ request: incoming, connection, reply }) => {
      if (incoming.op !== "subscribe_viewer") return;
      subscriptions.push(connection);
      reply({ kind: "viewer_subscribed", cursor: viewerCursor, snapshot: viewerSnapshot });
    });
    const client = startClient({ socketPath, reconnectDelayMs: 1, maxBytes: 4096 });
    const subscription = client.subscribeViewer("session-1");
    await within(subscription.established);
    const reading = subscription.next().then(() => "delivered", (/** @type {unknown} */ error) => error);

    server.socket?.destroy();
    await expect(within(reading)).resolves.toMatchObject({ code: "CONNECTION_CLOSED" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(subscriptions).toEqual([1]);
  });

  // The daemon publishes this frame when a stream stops for a reason its reader has to act on. It
  // arrives after the establishing request was answered, so nothing else could carry it.
  it("ends a viewer subscription on the daemon's stream-failure frame", async () => {
    const socketPath = await socketPathIn("viewer-stream-failed-");
    await daemonServer(socketPath, ({ socket, request: incoming, reply }) => {
      if (incoming.op !== "subscribe_viewer") return;
      reply({ kind: "viewer_subscribed", cursor: viewerCursor, snapshot: viewerSnapshot });
      // After the snapshot has landed: a failure in the same chunk as the answer ends the
      // subscription before its snapshot is delivered, which the refusal above already covers.
      setTimeout(() => socket.write(encodeJsonl({ version: 1, kind: "viewer_stream_failed", sessionId: "session-1", error: { code: "SUBSCRIBER_OVERFLOW", message: "Viewer subscriber exceeded its bounded queue", retryable: false } })), 0);
    });
    const client = startClient({ socketPath, maxBytes: 4096 });
    const subscription = client.subscribeViewer("session-1");
    await within(subscription.established);
    await expect(within(subscription.next())).rejects.toMatchObject({ code: "SUBSCRIBER_OVERFLOW" });
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
    const snapshot = { version: 1, sessionId: "session-1", registryRevision: 1, cursor, runtime: null, taskState: "READY", processState: "SLEEPING", outcome: "NONE", activity, model: null, thinkingLevel: null, items: [{ kind: "assistant_message", itemId: "answer", content: Array.from({ length: 10 }, () => ({ type: "text", text: "x".repeat(60_000) })) }], tools: [], pendingUi: [], errors: [] };
    const server = await daemonServer(socketPath, ({ reply }) => reply({ kind: "viewer_subscribed", cursor, snapshot }));
    const client = startClient({ socketPath, maxBytes: 1024 * 1024 });
    const read = (/** @type {string} */ requestId) => client.request({ version: 1, clientId: "client-1", requestId, op: "subscribe_viewer", payload: { sessionId: "session-1" } });
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
