import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonlDecoder, encodeJsonl } from "../runtime/jsonl.mjs";
import { createDaemonClient } from "./daemon-client.mjs";
const cleanups = [];
afterEach(async () => {
    while (cleanups.length > 0)
        await cleanups.pop()();
});
async function serverFixture(dropFirst = false) {
    const directory = await mkdtemp(join(tmpdir(), "client-"));
    const socketPath = join(directory, "control.sock");
    let requests = 0;
    const server = net.createServer((socket) => {
        const decoder = createJsonlDecoder({ maxBytes: 1024 });
        let authed = false;
        socket.on("data", (chunk) => {
            for (const value of decoder.push(chunk)) {
                if (!authed) {
                    authed = true;
                    socket.write(encodeJsonl({ version: 1, kind: "authenticated" }));
                    continue;
                }
                requests += 1;
                const incoming = value;
                if (dropFirst && requests === 1) {
                    socket.destroy();
                    continue;
                }
                socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "state", sessions: [] } }));
            }
        });
    });
    await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
    cleanups.push(async () => {
        await new Promise((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    });
    return { socketPath, count: () => requests };
}
async function waitFor(predicate) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error("Timed out waiting for test condition");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
async function within(promise) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for protocol recovery")), 2_000)),
    ]);
}
const request = { version: 1, clientId: "client-1", requestId: "exact-request-id", op: "get_state", payload: {} };
describe("daemon client", () => {
    it("authenticates and correlates responses by exact request ID", async () => {
        const fixture = await serverFixture();
        const client = createDaemonClient({ socketPath: fixture.socketPath, token: "secret", maxBytes: 1024, clientId: "client-1" });
        cleanups.push(() => client.close());
        await client.connect();
        expect(await client.request(request)).toMatchObject({ requestId: "exact-request-id", ok: true });
    });
    it("reconnects and resends the same request after disconnect without worker-side cancellation", async () => {
        const fixture = await serverFixture(true);
        const client = createDaemonClient({ socketPath: fixture.socketPath, token: "secret", maxBytes: 1024, reconnectDelayMs: 1, clientId: "client-1" });
        cleanups.push(() => client.close());
        expect(await client.request(request)).toMatchObject({ requestId: "exact-request-id", ok: true });
        expect(fixture.count()).toBe(2);
    });
    it("does not replay a transactional request after its authenticated socket disconnects", async () => {
        const fixture = await serverFixture(true);
        const client = createDaemonClient({ socketPath: fixture.socketPath, token: "secret", maxBytes: 1024, reconnect: false, clientId: "client-1" });
        cleanups.push(() => client.close());
        await expect(within(client.request(request))).rejects.toMatchObject({ code: "CONNECTION_CLOSED", submitted: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fixture.count()).toBe(1);
    });
    it("retains an unresolved request while reconnect attempts fail until the daemon starts", async () => {
        const directory = await mkdtemp(join(tmpdir(), "client-late-"));
        const socketPath = join(directory, "control.sock");
        const client = createDaemonClient({ socketPath, token: "secret", maxBytes: 1024, reconnectDelayMs: 2, clientId: "client-1" });
        const response = client.request(request);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const server = net.createServer((socket) => {
            const decoder = createJsonlDecoder({ maxBytes: 1024 });
            let authed = false;
            socket.on("data", (chunk) => {
                for (const value of decoder.push(chunk)) {
                    if (!authed) {
                        authed = true;
                        socket.write(encodeJsonl({ version: 1, kind: "authenticated" }));
                    }
                    else {
                        const incoming = value;
                        socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "state", sessions: [] } }));
                    }
                }
            });
        });
        await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
        cleanups.push(async () => {
            await client.close();
            await new Promise((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        });
        await expect(response).resolves.toMatchObject({ requestId: request.requestId, ok: true });
    });
    it("reconnects subscriptions from the acknowledged cursor and wires successful ack responses", async () => {
        const directory = await mkdtemp(join(tmpdir(), "client-ack-"));
        const socketPath = join(directory, "control.sock");
        const subscriptions = [];
        let active;
        const server = net.createServer((socket) => {
            active = socket;
            const decoder = createJsonlDecoder({ maxBytes: 1024 });
            let authed = false;
            socket.on("data", (chunk) => {
                for (const value of decoder.push(chunk)) {
                    if (!authed) {
                        authed = true;
                        socket.write(encodeJsonl({ version: 1, kind: "authenticated" }));
                        continue;
                    }
                    const incoming = value;
                    if (incoming.op === "subscribe") {
                        subscriptions.push(incoming.payload.after);
                        socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "subscribed", cursor: incoming.payload.after } }));
                    }
                    else if (incoming.op === "ack") {
                        socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "acknowledged", cursor: incoming.payload.cursor } }));
                    }
                }
            });
        });
        await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
        const client = createDaemonClient({ socketPath, token: "secret", maxBytes: 1024, reconnectDelayMs: 1, clientId: "client-1" });
        cleanups.push(async () => {
            await client.close();
            await new Promise((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        });
        const zero = { daemonEpoch: "epoch-1", sequence: "0" };
        const one = { daemonEpoch: "epoch-1", sequence: "1" };
        const iterator = client.subscribe(zero)[Symbol.asyncIterator]();
        await waitFor(() => subscriptions.length === 1);
        const pendingEvent = iterator.next();
        active?.write(encodeJsonl({ version: 1, cursor: one, occurredAt: "2026-01-01T00:00:00.000Z", kind: "attachment_changed", payload: { sessionId: "s", clientId: "client-1", role: "observer", attached: true } }));
        await expect(pendingEvent).resolves.toMatchObject({ value: { cursor: one }, done: false });
        active?.destroy();
        await waitFor(() => subscriptions.length === 2);
        expect(subscriptions[1]).toEqual(zero);
        await client.request({ version: 1, clientId: "client-1", requestId: "ack-1", op: "ack", payload: { cursor: one } });
        active?.destroy();
        await waitFor(() => subscriptions.length === 3);
        expect(subscriptions[2]).toEqual(one);
        await iterator.return?.();
    });
    it("binds requests to one configured client identity, including NUL-bearing IDs", async () => {
        const fixture = await serverFixture();
        const client = createDaemonClient({ socketPath: fixture.socketPath, token: "secret", maxBytes: 1024, clientId: "client\0one" });
        cleanups.push(() => client.close());
        await expect(client.request({ ...request, clientId: "other" })).rejects.toMatchObject({ code: "CLIENT_ID_MISMATCH" });
        await expect(client.request({ ...request, clientId: "client\0one", requestId: "request\0one" })).resolves.toMatchObject({ requestId: "request\0one" });
    });
    it("rejects changed payload reuse locally", async () => {
        const fixture = await serverFixture();
        const client = createDaemonClient({ socketPath: fixture.socketPath, token: "secret", maxBytes: 1024, clientId: "client-1" });
        cleanups.push(() => client.close());
        await client.request(request);
        await expect(client.request({ ...request, payload: { changed: true } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });
    it("retains a request when a malformed response arrives and accepts a valid retry", async () => {
        const directory = await mkdtemp(join(tmpdir(), "client-malformed-response-"));
        const socketPath = join(directory, "control.sock");
        let connections = 0;
        const server = net.createServer((socket) => {
            connections += 1;
            const connection = connections;
            const decoder = createJsonlDecoder({ maxBytes: 1024 });
            let authed = false;
            socket.on("data", (chunk) => {
                for (const value of decoder.push(chunk)) {
                    if (!authed) {
                        authed = true;
                        socket.write(encodeJsonl({ version: 1, kind: "authenticated" }));
                        continue;
                    }
                    const incoming = value;
                    if (connection === 1) {
                        socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "state", sessions: "invalid" } }), () => socket.destroy());
                    }
                    else {
                        socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "state", sessions: [] } }));
                    }
                }
            });
        });
        await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
        const client = createDaemonClient({ socketPath, token: "secret", maxBytes: 1024, reconnectDelayMs: 1, clientId: "client-1" });
        const fatalErrors = [];
        client.onFatalError?.((error) => fatalErrors.push(error));
        cleanups.push(async () => {
            await client.close();
            await new Promise((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        });
        await expect(within(client.request(request))).resolves.toMatchObject({ ok: true, result: { kind: "state", sessions: [] } });
        expect(connections).toBe(2);
        expect(fatalErrors).toEqual([expect.objectContaining({ code: "MALFORMED_FRAME" })]);
    });
    it("retains a pending acknowledgement after a malformed ack without throwing from the listener", async () => {
        const directory = await mkdtemp(join(tmpdir(), "client-malformed-ack-"));
        const socketPath = join(directory, "control.sock");
        let connections = 0;
        const server = net.createServer((socket) => {
            connections += 1;
            const connection = connections;
            const decoder = createJsonlDecoder({ maxBytes: 1024 });
            let authed = false;
            socket.on("data", (chunk) => {
                for (const value of decoder.push(chunk)) {
                    if (!authed) {
                        authed = true;
                        socket.write(encodeJsonl({ version: 1, kind: "authenticated" }));
                        continue;
                    }
                    const incoming = value;
                    if (connection === 1) {
                        socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true }), () => socket.destroy());
                    }
                    else {
                        socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "acknowledged", cursor: incoming.payload.cursor } }));
                    }
                }
            });
        });
        await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
        const client = createDaemonClient({ socketPath, token: "secret", maxBytes: 1024, reconnectDelayMs: 1, clientId: "client-1" });
        cleanups.push(async () => {
            await client.close();
            await new Promise((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        });
        const cursor = { daemonEpoch: "epoch-1", sequence: "1" };
        const ack = { version: 1, clientId: "client-1", requestId: "ack-malformed", op: "ack", payload: { cursor } };
        await expect(within(client.request(ack))).resolves.toMatchObject({ ok: true, result: { kind: "acknowledged", cursor } });
        expect(connections).toBe(2);
    });
    it("coalesces superseded session updates instead of overflowing a slow list consumer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "client-coalesce-"));
  const socketPath = join(directory, "control.sock");
  const executable = { realpath: "/installed/pi", device: "1", inode: "2", size: 3, modifiedTimeNs: "4" };
  const session = (sessionId, sequence) => ({ schemaVersion: 1, revision: sequence, sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, canonicalSessionFile: `/sessions/${sessionId}.jsonl`, cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "assistant_streaming", summary: `chunk ${sequence}`, updatedAt: "2026-01-01T00:00:00.000Z" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  const event = (sessionId, sequence) => ({ version: 1, cursor: { daemonEpoch: "epoch-1", sequence: String(sequence) }, occurredAt: "2026-01-01T00:00:00.000Z", kind: "session_changed", payload: { session: session(sessionId, sequence) } });
  const server = net.createServer((socket) => {
    const decoder = createJsonlDecoder({ maxBytes: 8192 });
    let authed = false;
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk)) {
        if (!authed) { authed = true; socket.write(encodeJsonl({ version: 1, kind: "authenticated" })); continue; }
        const incoming = value;
        socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "subscribed", cursor: { daemonEpoch: "epoch-1", sequence: "0" } } }));
        for (let sequence = 1; sequence <= 12; sequence += 1) socket.write(encodeJsonl(event("streaming", sequence)));
        socket.write(encodeJsonl(event("other", 13)));
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  const client = createDaemonClient({ socketPath, token: "secret", maxBytes: 8192, reconnectDelayMs: 1, clientId: "client-1", subscriberLimit: 4, reconnect: false });
  cleanups.push(async () => {
    await client.close();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const iterator = client.subscribe({ daemonEpoch: "epoch-1", sequence: "0" })[Symbol.asyncIterator]();
  const first = await within(iterator.next());
  expect(first.value.payload.session.sessionId).toBe("streaming");
  const second = await within(iterator.next());
  expect(second.value.cursor.sequence).toBe("12");
  const third = await within(iterator.next());
  expect(third.value.payload.session.sessionId).toBe("other");
  await iterator.return?.();
});

it("drops a malformed event and reconnects before dispatching a valid event", async () => {
        const directory = await mkdtemp(join(tmpdir(), "client-malformed-event-"));
        const socketPath = join(directory, "control.sock");
        let connections = 0;
        const executable = { realpath: "/installed/pi", device: "1", inode: "2", size: 3, modifiedTimeNs: "4" };
        const process = { pid: 10, startIdentity: "start", processGroupId: 10 };
        const runtime = { executable, piVersion: "1.0.0", capabilities: { executable, reportedVersion: "1.0.0", rpcMode: true, jsonl: true, commands: ["get_state", "prompt", "follow_up", "steer", "abort", "extension_ui_response"], events: ["required_live_events"], missingRequired: [] }, rpcAdapterVersion: 1, viewerProtocolVersion: 1, supervisor: process, piChild: process };
        const session = { schemaVersion: 1, revision: 1, sessionId: "s", sessionFile: "/sessions/s.jsonl", canonicalSessionFile: "/sessions/s.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "launching", summary: "Starting", updatedAt: "2026-01-01T00:00:00.000Z" }, runtime, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
        const validEvent = { version: 1, cursor: { daemonEpoch: "epoch-1", sequence: "1" }, occurredAt: "2026-01-01T00:00:00.000Z", kind: "session_changed", payload: { session } };
        const server = net.createServer((socket) => {
            connections += 1;
            const connection = connections;
            const decoder = createJsonlDecoder({ maxBytes: 1024 });
            let authed = false;
            socket.on("data", (chunk) => {
                for (const value of decoder.push(chunk)) {
                    if (!authed) {
                        authed = true;
                        socket.write(encodeJsonl({ version: 1, kind: "authenticated" }));
                        continue;
                    }
                    const incoming = value;
                    socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "subscribed", cursor: { daemonEpoch: "epoch-1", sequence: "0" } } }));
                    if (connection === 1) {
                        socket.write(encodeJsonl({ ...validEvent, cursor: { daemonEpoch: "epoch-1", sequence: 1 } }), () => socket.destroy());
                    }
                    else {
                        socket.write(encodeJsonl(validEvent));
                    }
                }
            });
        });
        await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
        const client = createDaemonClient({ socketPath, token: "secret", maxBytes: 4096, reconnectDelayMs: 1, clientId: "client-1" });
        cleanups.push(async () => {
            await client.close();
            await new Promise((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        });
        const iterator = client.subscribe({ daemonEpoch: "epoch-1", sequence: "0" })[Symbol.asyncIterator]();
        await expect(within(iterator.next())).resolves.toMatchObject({ value: validEvent, done: false });
        expect(connections).toBe(2);
        await iterator.return?.();
    });
    it("gets viewer snapshots, subscribes by session cursor, and acknowledges only after consumer processing", async () => {
        const directory = await mkdtemp(join(tmpdir(), "viewer-client-"));
        const socketPath = join(directory, "control.sock");
        const operations = [];
        const zero = { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: "0" };
        const one = { ...zero, sequence: "1" };
        const activity = { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "source", startedAt: "2026-08-25T00:00:00.000Z" };
        const snapshot = { version: 1, sessionId: "session-1", registryRevision: 1, cursor: zero, runtime: null, role: "observer", taskState: "READY", processState: "SLEEPING", outcome: "NONE", activity, model: null, thinkingLevel: null, items: [], tools: [], pendingUi: [], errors: [] };
        const event = { version: 1, sessionId: "session-1", eventId: "event-1", cursor: one, timestamp: "2026-08-25T00:00:00.000Z", payload: { kind: "user_message", itemId: "user-1", content: [{ type: "text", text: "hello" }] } };
        const server = net.createServer((socket) => {
            const decoder = createJsonlDecoder({ maxBytes: 4096 });
            let authed = false;
            socket.on("data", (chunk) => {
                for (const value of decoder.push(chunk)) {
                    if (!authed) { authed = true; socket.write(encodeJsonl({ version: 1, kind: "authenticated" })); continue; }
                    const incoming = value;
                    operations.push(incoming.op);
                    if (incoming.op === "get_viewer_snapshot") socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "viewer_snapshot", snapshot } }));
                    else if (incoming.op === "subscribe_viewer") {
                        socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "viewer_subscribed", cursor: zero } }));
                        socket.write(encodeJsonl(event));
                    } else if (incoming.op === "ack_viewer") socket.write(encodeJsonl({ version: 1, requestId: incoming.requestId, ok: true, result: { kind: "viewer_acknowledged", cursor: incoming.payload.cursor } }));
                }
            });
        });
        await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
        const client = createDaemonClient({ socketPath, token: "secret", maxBytes: 4096, clientId: "client-1" });
        cleanups.push(async () => { await client.close(); await new Promise((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
        await expect(client.getViewerSnapshot("session-1")).resolves.toEqual(snapshot);
        const iterator = client.subscribeViewer("session-1", zero)[Symbol.asyncIterator]();
        const delivered = await within(iterator.next());
        expect(delivered).toEqual({ value: event, done: false });
        expect(operations).not.toContain("ack_viewer");
        await expect(client.ackViewer(one)).resolves.toEqual(one);
        expect(operations).toEqual(["get_viewer_snapshot", "subscribe_viewer", "ack_viewer"]);
        await iterator.return?.();
    });
    it("sets a session color without a revision precondition", async () => {
        const directory = await mkdtemp(join(tmpdir(), "client-color-"));
        const socketPath = join(directory, "daemon.sock");
        /** @type {any[]} */
        const payloads = [];
        const server = net.createServer((socket) => {
            const decoder = createJsonlDecoder({ maxBytes: 4096 });
            let authed = false;
            socket.on("data", (chunk) => {
                for (const value of decoder.push(chunk)) {
                    if (!authed) { authed = true; socket.write(encodeJsonl({ version: 1, kind: "authenticated" })); continue; }
                    payloads.push({ op: value.op, payload: value.payload });
                    socket.write(encodeJsonl({ version: 1, requestId: value.requestId, ok: true, result: { kind: "session_colored", sessionId: value.payload.sessionId, revision: payloads.length, color: value.payload.color } }));
                }
            });
        });
        await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
        const client = createDaemonClient({ socketPath, token: "secret", maxBytes: 4096, clientId: "client-1" });
        cleanups.push(async () => { await client.close(); await new Promise((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
        await expect(client.setSessionColor("session-1", "amber")).resolves.toMatchObject({ kind: "session_colored", color: "amber", revision: 1 });
        await expect(client.setSessionColor("session-1", null)).resolves.toMatchObject({ color: null });
        expect(payloads).toEqual([
            { op: "set_session_color", payload: { sessionId: "session-1", color: "amber" } },
            { op: "set_session_color", payload: { sessionId: "session-1", color: null } },
        ]);
        await expect(client.setSessionColor("", "amber")).rejects.toThrow(/sessionId/i);
    });

    it("finishes subscriptions created after the client closes", async () => {
        const client = createDaemonClient({ socketPath: "/unused", token: "secret", maxBytes: 1024, clientId: "client-1" });
        await client.close();
        const iterator = client.subscribe()[Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    });
});
