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

  // Operator-visible failure: a snapshot with no stated coverage cannot be told from one taken before
  // the change that provoked the read, so the list could sit on a row that never updated again. The
  // response contract requires the cursor, and the refusal has to reach the read that asked for it.
  it("reads rows with their coverage cursor and fails the read when a daemon sends none", async () => {
    const socketPath = await socketPathIn("client-state-");
    let reads = 0;
    await daemonServer(socketPath, ({ socket, request: incoming, reply }) => {
      reads += 1;
      if (reads === 1) reply(emptyState);
      else socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "state", sessions: [] } }));
    });
    const client = startClient({ socketPath });
    await expect(client.getState()).resolves.toEqual({ sessions: [], cursor: emptyState.cursor });
    await expect(client.getState()).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  // A destructive command claims nothing: it carries the installation clientId, its own request ID,
  // and an exact revision, and that is the whole authorization the daemon needs. It travels on its
  // own connection, so a socket that dies mid-command is this command's ambiguity, not the list's.
  it.each(["stop"])("sends %s alone on its own connection, with no attachment around it", async (operation) => {
    const socketPath = await socketPathIn("client-destructive-");
    /** @type {any[]} */
    const requests = [];
    const server = await daemonServer(socketPath, ({ request: incoming, connection, reply }) => {
      requests.push({ connection, ...incoming });
      reply({ kind: "command", sessionId: incoming.payload.sessionId });
    });
    const client = startClient({ socketPath, attachId: "attach-one" });
    await client.connect();
    await client[operation]("exact-session", 3, `${operation}-request`);
    expect(requests).toEqual([{ connection: 2, version: 1, clientId: "client-1", requestId: `${operation}-request`, op: operation, payload: { sessionId: "exact-session", revision: 3 } }]);
    // The second connection is another connection of the same dashboard process, not another process.
    expect(server.authentications.map((frame) => frame.attachId)).toEqual(["attach-one", "attach-one"]);
  });

  // An ambiguous transport failure after submission is never replayed silently: it becomes
  // DELIVERY_UNKNOWN carrying the identity it was sent under, and the row's revision is the record.
  it.each(["delete"])("classifies %s interrupted by a dying socket as delivery unknown", async (operation) => {
    const socketPath = await socketPathIn("client-destructive-lost-");
    await daemonServer(socketPath, ({ socket, request: incoming }) => {
      if (incoming.op === operation) socket.destroy();
    });
    const client = startClient({ socketPath });
    await expect(within(client[operation]("exact-session", 3, `${operation}-request`)))
      .rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "client-1", requestId: `${operation}-request` });
  });

  it.each(["stop"])("treats a refused %s as a structured refusal", async (operation) => {
    const socketPath = await socketPathIn("client-destructive-refused-");
    await daemonServer(socketPath, ({ refuse }) => refuse({ code: "REVISION_CONFLICT", message: `${operation} refused` }));
    const client = startClient({ socketPath });
    await expect(within(client[operation]("exact-session", 3, `${operation}-request`)))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT", message: `${operation} refused` });
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
    const subscription = await within(client.subscribeViewer("session-1"));
    expect(subscription.snapshot).toEqual(viewerSnapshot);
    await expect(within(subscription.events.next())).resolves.toEqual({ value: viewerEvent, done: false });
    expect(/** @type {Record<string, unknown>} */ (client).getViewerSnapshot).toBeUndefined();
    expect(/** @type {Record<string, unknown>} */ (client).ackViewer).toBeUndefined();
    expect(operations).toEqual(["subscribe_viewer"]);
    subscription.unsubscribe();
  });

  // The queue absorbs a burst the reader has not reached yet, and it is bounded because an unbounded
  // one grows with the daemon's output rather than with what the operator is reading. Past the bound
  // the subscription ends, and the reader is told why on its next read instead of being handed a
  // stream with a hole in it: the viewer answers this code with one reload from a fresh snapshot.
  it("ends a viewer subscriber that outruns its bounded queue rather than growing it", async () => {
    const socketPath = await socketPathIn("viewer-bound-");
    await daemonServer(socketPath, ({ socket, request: incoming, reply }) => {
      if (incoming.op === "subscribe_viewer") { reply({ kind: "viewer_subscribed", cursor: viewerCursor, snapshot: viewerSnapshot }); return; }
      // Three events for a queue bounded at two, while nothing is reading it: the third is one past
      // the bound.
      for (let index = 0; index < 3; index += 1) socket.write(encodeJsonl({ ...viewerEvent, eventId: `event-${index}` }));
      reply({ kind: "session_colored", sessionId: "session-1", revision: 1, color: "amber" });
    });
    const client = startClient({ socketPath, maxBytes: 4096, subscriberLimit: 2 });
    const subscription = await within(client.subscribeViewer("session-1"));
    // The burst is asked for after this subscription is established, so it cannot arrive in the same
    // chunk as the answer and end the subscription before there is anything to overflow.
    await within(client.setSessionColor("session-1", "amber"));
    await expect(within(subscription.events.next())).rejects.toMatchObject({ code: "SUBSCRIBER_OVERFLOW" });
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
    await expect(within(client.subscribeViewer("session-1"))).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
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

  // A session another dashboard already holds open still opens here: there is no read-only role, and
  // the attach asks the daemon to start a worker that has exited.
  it("opens one session on this connection and refuses an answer that is not an attachment", async () => {
    const socketPath = await socketPathIn("client-attach-");
    /** @type {any[]} */
    const payloads = [];
    await daemonServer(socketPath, ({ request: incoming, reply }) => {
      payloads.push({ op: incoming.op, payload: incoming.payload });
      reply(payloads.length === 1 ? { kind: "attached", sessionId: incoming.payload.sessionId } : { kind: "detached", sessionId: incoming.payload.sessionId });
    });
    const client = startClient({ socketPath, maxBytes: 4096 });
    await expect(client.attach("session-1")).resolves.toMatchObject({ kind: "attached", sessionId: "session-1" });
    await expect(client.attach("session-1")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(payloads[0]).toEqual({ op: "attach", payload: { sessionId: "session-1", activate: true } });
  });

  // A fast reopen can outrun its own detach, and the two would then race the daemon's record of this
  // connection's open sessions. Only the same session waits.
  it("holds a reattach behind the same session's in-flight detach and lets another session past", async () => {
    const socketPath = await socketPathIn("client-detach-order-");
    /** @type {string[]} */
    const order = [];
    /** @type {(() => void) | undefined} */
    let releaseDetach;
    await daemonServer(socketPath, ({ request: incoming, reply }) => {
      if (incoming.op === "detach") {
        order.push("detach:start");
        releaseDetach = () => { order.push("detach:done"); reply({ kind: "detached", sessionId: incoming.payload.sessionId }); };
        return;
      }
      order.push(`attach:${incoming.payload.sessionId}`);
      reply({ kind: "attached", sessionId: incoming.payload.sessionId });
    });
    const client = startClient({ socketPath, maxBytes: 4096 });
    void client.detach("session-1").catch(() => {});
    await waitFor(() => order.length === 1);
    const reattach = client.attach("session-1");
    await expect(within(client.attach("other"))).resolves.toMatchObject({ kind: "attached" });
    expect(order).toEqual(["detach:start", "attach:other"]);
    releaseDetach?.();
    await expect(within(reattach)).resolves.toMatchObject({ kind: "attached", sessionId: "session-1" });
    expect(order).toEqual(["detach:start", "attach:other", "detach:done", "attach:session-1"]);
  });

  // The commands are what the operator asked for; the summary model and the row are decoration the
  // viewer has defaults for, so neither may fail an otherwise good menu.
  it("reads a session menu and keeps it when the settings and rows behind it refuse", async () => {
    const socketPath = await socketPathIn("client-menu-");
    const commands = { kind: "session_commands", sessionId: "session-1", commands: [{ name: "/review", source: "extension" }], models: [], model: null };
    const row = {
      schemaVersion: 1, revision: 7, sessionId: "session-1", sessionFile: "/sessions/session-1.jsonl", canonicalSessionFile: "/sessions/session-1.jsonl",
      cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", color: "amber", name: "recurse",
      activity: { kind: "assistant_final", summary: "done", updatedAt: "2026-08-25T00:00:00.000Z" },
      createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
    };
    await daemonServer(socketPath, ({ request: incoming, reply, refuse }) => {
      if (incoming.op === "get_session_commands") reply(commands);
      else if (incoming.op === "get_state") reply({ kind: "state", sessions: [row], cursor: { daemonEpoch: "epoch-1", sequence: "1" } });
      else refuse({ code: "SETTINGS_UNAVAILABLE", message: "Settings are unavailable" });
    });
    const client = startClient({ socketPath, maxBytes: 8192 });
    await expect(client.sessionMenu("session-1")).resolves.toMatchObject({ commands: commands.commands, summaryModel: null, color: "amber", name: "recurse", registryRevision: 7 });
  });

  // The operator's text stays in his composer because the refusal reaches the caller, and the
  // transcript records `retryable` from the daemon rather than guessing it.
  it("raises a refused session command with the daemon's own code and retryable flag", async () => {
    const socketPath = await socketPathIn("client-command-");
    /** @type {any[]} */
    const payloads = [];
    await daemonServer(socketPath, ({ request: incoming, reply, refuse }) => {
      payloads.push({ op: incoming.op, payload: incoming.payload });
      if (payloads.length === 1) reply({ kind: "command", sessionId: "session-1" });
      else refuse({ code: "WORKER_RECONNECTING", message: "Session worker is reconnecting", retryable: true });
    });
    const client = startClient({ socketPath, maxBytes: 4096 });
    await expect(client.command("prompt", { sessionId: "session-1", text: "ship it" })).resolves.toMatchObject({ kind: "command" });
    await expect(client.command("prompt", { sessionId: "session-1", text: "ship it" })).rejects.toMatchObject({ code: "WORKER_RECONNECTING", retryable: true });
    expect(payloads.map((entry) => entry.op)).toEqual(["prompt", "prompt"]);
  });

});
