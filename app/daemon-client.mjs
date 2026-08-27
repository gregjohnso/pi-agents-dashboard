import net from "node:net";
import { randomUUID } from "node:crypto";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { parseDaemonResponse, validateSessionRecord } from "../shared/contracts.mjs";
import { parseViewerEvent, parseViewerSnapshot } from "../shared/viewer-contracts.mjs";
export class DaemonClientError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "DaemonClientError";
        this.code = code;
    }
}
const OPERATIONS = ["get_state", "launch", "attach", "detach", "prompt", "steer", "follow_up", "interrupt", "stop", "delete", "ui_response", "subscribe", "ack", "get_viewer_snapshot", "subscribe_viewer", "ack_viewer", "resolve_delivery", "get_session_commands", "session_command", "set_session_color"];
const COMMAND_STAGES = ["ACCEPTED", "DELIVERY_ATTEMPTED", "WORKER_ACKNOWLEDGED", "COMPLETED", "DELIVERY_UNKNOWN", "FAILED"];
function readRecord(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TypeError(`${path} must be a plain object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError(`${path} must be a plain object`);
    return value;
}
function requireKeys(record, required, optional, path) {
    for (const key of required) {
        if (!Object.hasOwn(record, key))
            throw new TypeError(`${path}.${key} is required`);
    }
    const allowed = new Set([...required, ...optional]);
    const unknown = Object.keys(record).find((key) => !allowed.has(key));
    if (unknown !== undefined)
        throw new TypeError(`Unknown ${path} field: ${unknown}`);
}
function readString(record, key, path) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0)
        throw new TypeError(`${path}.${key} must be a non-empty string`);
    return value;
}
function readEnum(record, key, values, path) {
    const value = record[key];
    if (typeof value !== "string" || !values.includes(value))
        throw new TypeError(`${path}.${key} is invalid`);
    return value;
}
function validateCursor(value, path) {
    const cursor = readRecord(value, path);
    requireKeys(cursor, ["daemonEpoch", "sequence"], [], path);
    readString(cursor, "daemonEpoch", path);
    const sequence = readString(cursor, "sequence", path);
    if (!/^(0|[1-9]\d*)$/.test(sequence))
        throw new TypeError(`${path}.sequence must be a canonical unsigned integer string`);
}
function validateDashboardError(value, path) {
    const error = readRecord(value, path);
    requireKeys(error, ["code", "message", "retryable"], [], path);
    readString(error, "code", path);
    if (typeof error.message !== "string")
        throw new TypeError(`${path}.message must be a string`);
    if (typeof error.retryable !== "boolean")
        throw new TypeError(`${path}.retryable must be a boolean`);
}
function validateProcessIdentity(value, path) {
    const process = readRecord(value, path);
    requireKeys(process, ["pid", "startIdentity", "processGroupId"], [], path);
    if (!Number.isSafeInteger(process.pid) || !Number.isSafeInteger(process.processGroupId))
        throw new TypeError(`${path} process IDs must be safe integers`);
    readString(process, "startIdentity", path);
}
function validateSession(value, path) {
    const session = readRecord(value, path);
    requireKeys(session, ["schemaVersion", "revision", "sessionId", "sessionFile", "canonicalSessionFile", "cwd", "taskState", "processState", "outcome", "activity", "createdAt", "updatedAt"], ["name", "nameGenerated", "model", "thinkingLevel", "ownership", "isolation", "latestRunId", "runtime", "summary"], path);
    if (session.schemaVersion !== 1 || !Number.isSafeInteger(session.revision))
        throw new TypeError(`${path} schema version or revision is invalid`);
    for (const key of ["sessionId", "sessionFile", "canonicalSessionFile", "cwd", "createdAt", "updatedAt"])
        readString(session, key, path);
    readEnum(session, "taskState", ["WORKING", "WAITING", "READY", "FAILED", "STOPPED"], path);
    readEnum(session, "processState", ["LIVE", "SLEEPING", "EXITED", "STALE"], path);
    readEnum(session, "outcome", ["NONE", "COMPLETED", "READY_FOR_REVIEW"], path);
    const activity = readRecord(session.activity, `${path}.activity`);
    requireKeys(activity, ["kind", "summary", "updatedAt"], [], `${path}.activity`);
    readString(activity, "kind", `${path}.activity`);
    if (typeof activity.summary !== "string")
        throw new TypeError(`${path}.activity.summary must be a string`);
    readString(activity, "updatedAt", `${path}.activity`);
    for (const key of ["name", "thinkingLevel", "latestRunId"]) {
        if (Object.hasOwn(session, key))
            readString(session, key, path);
    }
    if (Object.hasOwn(session, "model")) {
        const model = readRecord(session.model, `${path}.model`);
        requireKeys(model, ["provider", "id"], [], `${path}.model`);
        readString(model, "provider", `${path}.model`);
        readString(model, "id", `${path}.model`);
    }
    if (Object.hasOwn(session, "ownership")) {
        const ownership = readRecord(session.ownership, `${path}.ownership`);
        requireKeys(ownership, ["kind", "runId", "process", "acquiredAt", "heartbeatAt"], [], `${path}.ownership`);
        if (ownership.kind !== "managed")
            throw new TypeError(`${path}.ownership.kind is invalid`);
        readString(ownership, "runId", `${path}.ownership`);
        validateProcessIdentity(ownership.process, `${path}.ownership.process`);
        readString(ownership, "acquiredAt", `${path}.ownership`);
        readString(ownership, "heartbeatAt", `${path}.ownership`);
    }
    if (Object.hasOwn(session, "isolation")) {
        const isolation = readRecord(session.isolation, `${path}.isolation`);
        const mode = readEnum(isolation, "mode", ["worktree", "shared_directory"], `${path}.isolation`);
        if (mode === "worktree") {
            requireKeys(isolation, ["mode", "worktreePath", "branch"], [], `${path}.isolation`);
            readString(isolation, "worktreePath", `${path}.isolation`);
            readString(isolation, "branch", `${path}.isolation`);
        }
        else {
            requireKeys(isolation, ["mode", "canonicalCwd"], [], `${path}.isolation`);
            readString(isolation, "canonicalCwd", `${path}.isolation`);
        }
    }
}
function validateCommandStatus(value, path) {
    const status = readRecord(value, path);
    requireKeys(status, ["clientId", "requestId", "operation", "stage", "acceptedAt", "updatedAt"], ["error"], path);
    readString(status, "clientId", path);
    readString(status, "requestId", path);
    readEnum(status, "operation", OPERATIONS, path);
    readEnum(status, "stage", COMMAND_STAGES, path);
    readString(status, "acceptedAt", path);
    readString(status, "updatedAt", path);
    if (Object.hasOwn(status, "error"))
        validateDashboardError(status.error, `${path}.error`);
}
function parsePersistedEvent(value) {
    const event = readRecord(value, "Persisted event");
    requireKeys(event, ["version", "cursor", "occurredAt", "kind", "payload"], [], "persisted event");
    if (event.version !== 1)
        throw new TypeError("Persisted event version must be 1");
    validateCursor(event.cursor, "persisted event.cursor");
    readString(event, "occurredAt", "persisted event");
    const kind = readEnum(event, "kind", ["session_changed", "command_changed", "attachment_changed"], "persisted event");
    const payload = readRecord(event.payload, "persisted event.payload");
    if (kind === "session_changed") {
        requireKeys(payload, ["session"], [], "persisted event.payload");
        validateSessionRecord(payload.session, "persisted event.payload.session");
    }
    else if (kind === "command_changed") {
        requireKeys(payload, ["status"], [], "persisted event.payload");
        validateCommandStatus(payload.status, "persisted event.payload.status");
    }
    else {
        requireKeys(payload, ["sessionId", "clientId", "role", "attached"], [], "persisted event.payload");
        readString(payload, "sessionId", "persisted event.payload");
        readString(payload, "clientId", "persisted event.payload");
        readEnum(payload, "role", ["composer", "observer"], "persisted event.payload");
        if (typeof payload.attached !== "boolean")
            throw new TypeError("persisted event.payload.attached must be a boolean");
    }
    return value;
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
}
function laterCursor(current, candidate) {
    if (current === undefined || current.daemonEpoch !== candidate.daemonEpoch)
        return candidate;
    if (!/^(0|[1-9]\d*)$/.test(current.sequence) || !/^(0|[1-9]\d*)$/.test(candidate.sequence))
        return candidate;
    return BigInt(candidate.sequence) >= BigInt(current.sequence) ? candidate : current;
}
function laterViewerCursor(current, candidate) {
    if (current === undefined || current.daemonEpoch !== candidate.daemonEpoch || current.sessionId !== candidate.sessionId)
        return candidate;
    return BigInt(candidate.sequence) >= BigInt(current.sequence) ? candidate : current;
}
/** Create a bounded JSONL daemon client with optional reconnect-and-replay behavior. */
export function createDaemonClient({ socketPath, token, maxBytes, reconnectDelayMs = 50, maxReconnectDelayMs = 1_000, clientId, subscriberLimit = 100, reconnect = true, }) {
    if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 0)
        throw new TypeError("reconnectDelayMs must be a non-negative safe integer");
    if (!Number.isSafeInteger(maxReconnectDelayMs) || maxReconnectDelayMs < reconnectDelayMs)
        throw new TypeError("maxReconnectDelayMs must be at least reconnectDelayMs");
    if (!Number.isSafeInteger(subscriberLimit) || subscriberLimit < 1)
        throw new TypeError("subscriberLimit must be a positive safe integer");
    if (typeof clientId !== "string" || clientId.length === 0)
        throw new TypeError("clientId is required");
    if (typeof reconnect !== "boolean")
        throw new TypeError("reconnect must be boolean");
    const encoder = createJsonlEncoder({ maxBytes });
    const pending = new Map();
    const seen = new Map();
    const subscribers = new Set();
    const viewerSubscribers = new Set();
    const fatalErrorListeners = new Set();
    const wakeDelays = new Set();
    let socket;
    let reconnectLoop;
    let closed = false;
    let authenticated = false;
    let everConnected = false;
    const hasWork = () => pending.size > 0 || subscribers.size > 0 || viewerSubscribers.size > 0;
    const reportFatalFrame = (error, fallbackCode) => {
        const typed = error;
        const reported = error instanceof DaemonClientError
            ? error
            : new DaemonClientError(typed.code ?? fallbackCode, typed.message ?? fallbackCode);
        for (const listener of fatalErrorListeners)
            listener(reported);
    };
    const send = (value) => {
        if (socket === undefined || !authenticated || socket.destroyed)
            throw new DaemonClientError("NOT_CONNECTED", "Daemon is not connected");
        socket.write(encoder.encode(value));
    };
    const sendPending = (item) => { send(item.request); item.sent = true; };
    const sendSubscriptions = () => {
        for (const subscriber of subscribers) {
            send({ version: 1, clientId, requestId: randomUUID(), op: "subscribe", payload: subscriber.acknowledgedAfter === undefined ? {} : { after: subscriber.acknowledgedAfter } });
        }
        for (const subscriber of viewerSubscribers) {
            send({ version: 1, clientId, requestId: randomUUID(), op: "subscribe_viewer", payload: { sessionId: subscriber.sessionId, ...(subscriber.acknowledgedAfter === undefined ? {} : { after: subscriber.acknowledgedAfter }) } });
        }
    };
    const dispatchEvent = (event) => {
        const supersededSessionId = event.kind === "session_changed" ? event.payload.session.sessionId : undefined;
        for (const subscriber of subscribers) {
            if (subscriber.ended)
                continue;
            if (subscriber.waiter !== undefined) {
                const waiter = subscriber.waiter;
                subscriber.waiter = undefined;
                waiter({ value: event, done: false });
                continue;
            }
            // One queued state per session: the newest record supersedes older ones and keeps cursors ascending.
            if (supersededSessionId !== undefined) {
                const superseded = subscriber.queue.findIndex((queued) => queued.kind === "session_changed" && queued.payload.session.sessionId === supersededSessionId);
                if (superseded !== -1)
                    subscriber.queue.splice(superseded, 1);
            }
            if (subscriber.queue.length >= subscriberLimit) {
                subscriber.error = new DaemonClientError("SUBSCRIBER_OVERFLOW", "Client subscriber exceeded its bounded queue");
                subscriber.ended = true;
                subscribers.delete(subscriber);
            }
            else {
                subscriber.queue.push(event);
            }
        }
    };
    const dispatchViewerEvent = (event) => {
        for (const subscriber of viewerSubscribers) {
            if (subscriber.ended || subscriber.sessionId !== event.sessionId)
                continue;
            if (subscriber.waiter !== undefined) {
                const waiter = subscriber.waiter;
                subscriber.waiter = undefined;
                waiter({ value: event, done: false });
            }
            else if (subscriber.queue.length >= subscriberLimit) {
                subscriber.error = new DaemonClientError("SUBSCRIBER_OVERFLOW", "Viewer subscriber exceeded its bounded queue");
                subscriber.ended = true;
                viewerSubscribers.delete(subscriber);
            }
            else {
                subscriber.queue.push(event);
            }
        }
    };
    const applyAcknowledgement = (cursor) => {
        for (const subscriber of subscribers)
            subscriber.acknowledgedAfter = laterCursor(subscriber.acknowledgedAfter, cursor);
    };
    const applyViewerAcknowledgement = (cursor) => {
        for (const subscriber of viewerSubscribers) {
            if (subscriber.sessionId === cursor.sessionId)
                subscriber.acknowledgedAfter = laterViewerCursor(subscriber.acknowledgedAfter, cursor);
        }
    };
    const waitForRetry = (milliseconds) => new Promise((resolve) => {
        if (closed || milliseconds === 0) {
            resolve();
            return;
        }
        let timer;
        const wake = () => {
            clearTimeout(timer);
            wakeDelays.delete(wake);
            resolve();
        };
        timer = setTimeout(wake, milliseconds);
        wakeDelays.add(wake);
    });
    const attemptConnection = () => new Promise((resolve, reject) => {
        if (closed) {
            reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
            return;
        }
        const candidate = net.createConnection(socketPath);
        socket = candidate;
        authenticated = false;
        const decoder = createJsonlDecoder({ maxBytes });
        let settled = false;
        const failAttempt = (error) => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        };
        candidate.on("connect", () => {
            try {
                candidate.write(encoder.encode({ version: 1, token }));
            }
            catch (error) {
                failAttempt(error);
                candidate.destroy();
            }
        });
        candidate.on("data", (chunk) => {
            try {
                const records = decoder.push(chunk);
                for (const record of records) {
                    if (!authenticated) {
                        const authentication = /** @type {Record<string, unknown> | null} */ (typeof record === "object" ? record : null);
                        if (authentication !== null && authentication.kind === "authenticated" && authentication.version === 1) {
                            authenticated = true;
                            everConnected = true;
                            for (const item of pending.values())
                                sendPending(item);
                            sendSubscriptions();
                            if (!settled) {
                                settled = true;
                                resolve();
                            }
                        }
                        else {
                            const error = new DaemonClientError("AUTHENTICATION_FAILED", "Daemon rejected authentication");
                            reportFatalFrame(error, "AUTHENTICATION_FAILED");
                            failAttempt(error);
                            candidate.destroy();
                        }
                        continue;
                    }
                    if (typeof record === "object" && record !== null && Object.hasOwn(record, "requestId")) {
                        const response = parseDaemonResponse(record);
                        const item = pending.get(response.requestId);
                        if (item === undefined)
                            continue;
                        pending.delete(response.requestId);
                        const entry = seen.get(response.requestId);
                        if (entry !== undefined)
                            entry.response = response;
                        if (item.request.op === "ack" && response.ok && response.result.kind === "acknowledged")
                            applyAcknowledgement(response.result.cursor);
                        if (item.request.op === "ack_viewer" && response.ok && response.result.kind === "viewer_acknowledged")
                            applyViewerAcknowledgement(response.result.cursor);
                        item.resolve(response);
                    }
                    else if (typeof record === "object" && record !== null && Object.hasOwn(record, "eventId")) {
                        dispatchViewerEvent(parseViewerEvent(record));
                    }
                    else {
                        dispatchEvent(parsePersistedEvent(record));
                    }
                }
            }
            catch (error) {
                reportFatalFrame(error, "MALFORMED_FRAME");
                failAttempt(error);
                candidate.destroy();
            }
        });
        candidate.on("error", failAttempt);
        candidate.on("close", () => {
            if (socket === candidate) {
                socket = undefined;
                authenticated = false;
            }
            const closedError = (submitted = false) => Object.assign(new DaemonClientError("CONNECTION_CLOSED", "Daemon connection closed"), { submitted });
            failAttempt(closedError());
            if (!reconnect) {
                for (const item of pending.values()) item.reject(closedError(item.sent));
                pending.clear();
                for (const subscriber of subscribers) { subscriber.error = closedError(); subscriber.ended = true; subscriber.waiter?.({ value: undefined, done: true }); }
                subscribers.clear();
                for (const subscriber of viewerSubscribers) { subscriber.error = closedError(); subscriber.ended = true; subscriber.waiter?.({ value: undefined, done: true }); }
                viewerSubscribers.clear();
            }
            else if (!closed && hasWork()) void startReconnectLoop().catch(() => { });
        });
    });
    function startReconnectLoop() {
        if (closed)
            return Promise.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
        if (!reconnect && everConnected && (socket === undefined || !authenticated || socket.destroyed))
            return Promise.reject(Object.assign(new DaemonClientError("CONNECTION_CLOSED", "Transactional daemon connection is closed"), { submitted: false }));
        if (socket !== undefined && authenticated && !socket.destroyed)
            return Promise.resolve();
        if (reconnectLoop !== undefined)
            return reconnectLoop;
        reconnectLoop = (async () => {
            let retryDelay = reconnectDelayMs;
            while (!closed) {
                try {
                    await attemptConnection();
                    return;
                }
                catch (error) {
                    if (!reconnect) throw error;
                    if (closed)
                        break;
                    await waitForRetry(retryDelay);
                    retryDelay = Math.min(maxReconnectDelayMs, Math.max(reconnectDelayMs, retryDelay === 0 ? 1 : retryDelay * 2));
                }
            }
            throw new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed");
        })().finally(() => {
            reconnectLoop = undefined;
        });
        return reconnectLoop;
    }
    return {
        connect: startReconnectLoop,
        createTransactionClient() { return createDaemonClient({ socketPath, token, maxBytes, reconnectDelayMs, maxReconnectDelayMs, clientId, subscriberLimit, reconnect: false }); },
        request(request) {
            if (closed)
                return Promise.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
            if (request.clientId !== clientId)
                return Promise.reject(new DaemonClientError("CLIENT_ID_MISMATCH", "Request clientId does not match the configured daemon client identity"));
            const serialized = canonical(request);
            const previous = seen.get(request.requestId);
            if (previous !== undefined && previous.canonical !== serialized)
                return Promise.reject(new DaemonClientError("IDEMPOTENCY_CONFLICT", "Request IDs were reused with changed content"));
            if (previous?.response !== undefined)
                return Promise.resolve(previous.response);
            const existing = pending.get(request.requestId);
            if (existing !== undefined)
                return existing.promise;
            let resolve;
            let reject;
            const promise = new Promise((yes, no) => {
                resolve = yes;
                reject = no;
            });
            pending.set(request.requestId, { request, resolve, reject, promise, sent: false });
            seen.set(request.requestId, { canonical: serialized });
            if (socket !== undefined && authenticated && !socket.destroyed)
                sendPending(pending.get(request.requestId));
            else
                void startReconnectLoop().catch(() => { });
            return promise;
        },
        subscribe(after) {
            const subscriber = { acknowledgedAfter: after, queue: [], ended: closed };
            if (!closed) {
                subscribers.add(subscriber);
                if (socket !== undefined && authenticated && !socket.destroyed) {
                    send({ version: 1, clientId, requestId: randomUUID(), op: "subscribe", payload: after === undefined ? {} : { after } });
                }
                else {
                    void startReconnectLoop().catch(() => { });
                }
            }
            const iterable = {
                [Symbol.asyncIterator]() { return this; },
                async next() {
                    if (subscriber.error !== undefined)
                        throw subscriber.error;
                    const event = subscriber.queue.shift();
                    if (event !== undefined)
                        return { value: event, done: false };
                    if (subscriber.ended)
                        return { value: undefined, done: true };
                    return new Promise((resolve) => { subscriber.waiter = resolve; });
                },
                async return() {
                    subscriber.ended = true;
                    subscribers.delete(subscriber);
                    subscriber.waiter?.({ value: undefined, done: true });
                    subscriber.waiter = undefined;
                    return { value: undefined, done: true };
                },
            };
            return iterable;
        },
        /** @param {string} sessionId @param {string | null} color */
        async setSessionColor(sessionId, color) {
            if (typeof sessionId !== "string" || sessionId.length === 0)
                throw new TypeError("sessionId is required");
            const response = await this.request({ version: 1, clientId, requestId: randomUUID(), op: "set_session_color", payload: { sessionId, color } });
            if (!response.ok)
                throw new DaemonClientError(response.error.code, response.error.message);
            return response.result;
        },
        async getViewerSnapshot(sessionId) {
            if (typeof sessionId !== "string" || sessionId.length === 0)
                throw new TypeError("sessionId is required");
            const response = await this.request({ version: 1, clientId, requestId: randomUUID(), op: "get_viewer_snapshot", payload: { sessionId } });
            if (!response.ok)
                throw new DaemonClientError(response.error.code, response.error.message);
            return parseViewerSnapshot(response.result.snapshot);
        },
        subscribeViewer(sessionId, after) {
            if (typeof sessionId !== "string" || sessionId.length === 0)
                throw new TypeError("sessionId is required");
            if (after !== undefined && after.sessionId !== sessionId)
                throw new DaemonClientError("VIEWER_SESSION_MISMATCH", "Viewer cursor belongs to another session");
            const subscriber = { sessionId, acknowledgedAfter: after, queue: [], ended: closed };
            if (!closed) {
                viewerSubscribers.add(subscriber);
                if (socket !== undefined && authenticated && !socket.destroyed) {
                    send({ version: 1, clientId, requestId: randomUUID(), op: "subscribe_viewer", payload: { sessionId, ...(after === undefined ? {} : { after }) } });
                }
                else {
                    void startReconnectLoop().catch(() => { });
                }
            }
            return {
                [Symbol.asyncIterator]() { return this; },
                async next() {
                    if (subscriber.error !== undefined)
                        throw subscriber.error;
                    const event = subscriber.queue.shift();
                    if (event !== undefined)
                        return { value: event, done: false };
                    if (subscriber.ended)
                        return { value: undefined, done: true };
                    return new Promise((resolve) => { subscriber.waiter = resolve; });
                },
                async return() {
                    subscriber.ended = true;
                    viewerSubscribers.delete(subscriber);
                    subscriber.waiter?.({ value: undefined, done: true });
                    subscriber.waiter = undefined;
                    return { value: undefined, done: true };
                },
            };
        },
        async ackViewer(cursor) {
            const response = await this.request({ version: 1, clientId, requestId: randomUUID(), op: "ack_viewer", payload: { cursor } });
            if (!response.ok)
                throw new DaemonClientError(response.error.code, response.error.message);
            return response.result.cursor;
        },
        onFatalError(listener) {
            fatalErrorListeners.add(listener);
            return () => fatalErrorListeners.delete(listener);
        },
        async close() {
            if (closed)
                return;
            closed = true;
            for (const wake of wakeDelays)
                wake();
            for (const item of pending.values())
                item.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
            pending.clear();
            for (const subscriber of subscribers) {
                subscriber.ended = true;
                subscriber.waiter?.({ value: undefined, done: true });
                subscriber.waiter = undefined;
            }
            subscribers.clear();
            for (const subscriber of viewerSubscribers) {
                subscriber.ended = true;
                subscriber.waiter?.({ value: undefined, done: true });
                subscriber.waiter = undefined;
            }
            viewerSubscribers.clear();
            fatalErrorListeners.clear();
            if (socket !== undefined && !socket.destroyed) {
                await new Promise((resolve) => {
                    socket.once("close", resolve);
                    socket.destroy();
                });
            }
        },
    };
}
