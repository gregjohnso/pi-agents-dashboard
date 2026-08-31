import net from "node:net";
import { randomUUID } from "node:crypto";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { CLIENT_PROTOCOL, parseDaemonResponse, parseListChanged } from "../shared/contracts.mjs";
import { parseViewerEvent, parseViewerSnapshot } from "../shared/viewer-contracts.mjs";
/**
 * How much answered-request history one client keeps to deduplicate a repeated request ID.
 * Every caller here mints a fresh `randomUUID` per operation, so a repeat only comes from a retry
 * of a still-recent request; past these bounds the request goes back to the daemon, whose command
 * journal deduplicates a mutation by clientId and requestId. The character budget is what keeps a
 * viewer snapshot, the one large response this client can receive, from being retained forever.
 */
const MAX_SEEN_REQUESTS = 256;
const MAX_SEEN_RESPONSE_CHARACTERS = 4 * 1024 * 1024;

export class DaemonClientError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "DaemonClientError";
        this.code = code;
    }
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
    let seenCharacters = 0;
    /** Forget the oldest answered requests first; a request still in flight is never forgotten. */
    const evictSeen = () => {
        for (const [requestId, entry] of seen) {
            if (seen.size <= MAX_SEEN_REQUESTS && seenCharacters <= MAX_SEEN_RESPONSE_CHARACTERS)
                return;
            if (pending.has(requestId))
                continue;
            seen.delete(requestId);
            seenCharacters -= entry.characters ?? 0;
        }
    };
    /** Callers notified that the session list changed. A notification carries nothing, so this set
     * never grows with a burst and holds no position to fall behind. */
    const listSubscribers = new Set();
    const viewerSubscribers = new Set();
    const fatalErrorListeners = new Set();
    const connectionListeners = new Set();
    const wakeDelays = new Set();
    let socket;
    let reconnectLoop;
    let closed = false;
    let authenticated = false;
    let everConnected = false;
    let connectionReported = false;
    /** Report only transitions: a daemon that stays down keeps retrying without repeating itself. */
    const reportConnection = (connected) => {
        if (connectionReported === connected)
            return;
        connectionReported = connected;
        for (const listener of connectionListeners)
            listener({ connected });
    };
    const hasWork = () => pending.size > 0 || listSubscribers.size > 0 || viewerSubscribers.size > 0;
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
    /**
     * Reopen an established list subscription on a new connection. A change published while the
     * socket was down leaves no trace, so a successful resubscription is itself a change. A daemon
     * that refuses the operation drops the subscriber rather than resending on every reconnect,
     * because resending is how one refusal became a reconnect storm.
     * @param {{ onChanged: () => void }} subscriber
     */
    const resubscribeListChanges = (subscriber) => {
        void requestResult("subscribe_list_changes", {}).then(() => {
            if (listSubscribers.has(subscriber)) subscriber.onChanged();
        }, (/** @type {unknown} */ error) => {
            listSubscribers.delete(subscriber);
            reportFatalFrame(error, "LIST_SUBSCRIPTION_FAILED");
        });
    };
    const sendSubscriptions = () => {
        for (const subscriber of listSubscribers) {
            if (subscriber.established) resubscribeListChanges(subscriber);
        }
        for (const subscriber of viewerSubscribers) {
            send({ version: 1, clientId, requestId: randomUUID(), op: "subscribe_viewer", payload: { sessionId: subscriber.sessionId, ...(subscriber.resumeAfter === undefined ? {} : { after: subscriber.resumeAfter }) } });
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
                candidate.write(encoder.encode({ version: 1, token, clientProtocol: CLIENT_PROTOCOL }));
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
                            reportConnection(true);
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
                        let response;
                        try {
                            response = parseDaemonResponse(record);
                        }
                        catch (error) {
                            // A skewed response frame belongs to exactly one request. Rejecting that one
                            // request keeps the connection, so a two-field contract skew cannot become a
                            // reconnect-and-resend storm. A frame no request owns still falls through to
                            // the fatal path below.
                            const claimed = /** @type {{ requestId?: unknown }} */ (record).requestId;
                            const owner = typeof claimed === "string" ? pending.get(claimed) : undefined;
                            if (owner === undefined)
                                throw error;
                            pending.delete(/** @type {string} */ (claimed));
                            owner.reject(Object.assign(new DaemonClientError("MALFORMED_RESPONSE", error instanceof Error ? error.message : "Daemon response could not be parsed"), { submitted: true, cause: error }));
                            continue;
                        }
                        const item = pending.get(response.requestId);
                        if (item === undefined)
                            continue;
                        pending.delete(response.requestId);
                        const entry = seen.get(response.requestId);
                        if (entry !== undefined) {
                            entry.response = response;
                            entry.characters = JSON.stringify(response)?.length ?? 0;
                            seenCharacters += entry.characters;
                            evictSeen();
                        }
                        item.resolve(response);
                    }
                    else if (typeof record === "object" && record !== null && Object.hasOwn(record, "eventId")) {
                        dispatchViewerEvent(parseViewerEvent(record));
                    }
                    else {
                        parseListChanged(record);
                        for (const subscriber of [...listSubscribers]) subscriber.onChanged();
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
            reportConnection(false);
            const closedError = (submitted = false) => Object.assign(new DaemonClientError("CONNECTION_CLOSED", "Daemon connection closed"), { submitted });
            failAttempt(closedError());
            if (!reconnect) {
                for (const item of pending.values()) item.reject(closedError(item.sent));
                pending.clear();
                listSubscribers.clear();
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
    /** Send one operation and unwrap its result; a daemon failure keeps that operation's own error code. */
    const requestResult = async (op, payload) => {
        const response = await client.request({ version: 1, clientId, requestId: randomUUID(), op, payload });
        if (!response.ok)
            throw new DaemonClientError(response.error.code, response.error.message);
        return response.result;
    };
    /** One bounded async iterator over a subscriber's queue; returning early unregisters it. */
    const subscriberIterable = (subscriber, registry) => ({
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
            registry.delete(subscriber);
            subscriber.waiter?.({ value: undefined, done: true });
            subscriber.waiter = undefined;
            return { value: undefined, done: true };
        },
    });
    const client = {
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
            seen.set(request.requestId, { canonical: serialized, characters: 0 });
            evictSeen();
            if (socket !== undefined && authenticated && !socket.destroyed)
                sendPending(pending.get(request.requestId));
            else
                void startReconnectLoop().catch(() => { });
            return promise;
        },
        /**
         * Subscribe to payload-free list invalidations, then read `get_state`. Subscribing first is
         * what makes the read safe: a change published while the read is in flight arrives as a
         * notification instead of being missed. Establishment is awaited, so a daemon without this
         * operation refuses here rather than leaving a list that never refreshes again.
         * @param {() => void} onChanged @returns {Promise<() => void>}
         */
        async subscribeListChanges(onChanged) {
            if (typeof onChanged !== "function")
                throw new TypeError("onChanged is required");
            if (closed)
                throw new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed");
            /** @type {{ onChanged: () => void, established: boolean }} */
            const subscriber = { onChanged, established: false };
            listSubscribers.add(subscriber);
            try {
                await requestResult("subscribe_list_changes", {});
            }
            catch (error) {
                listSubscribers.delete(subscriber);
                throw error;
            }
            subscriber.established = true;
            return () => { listSubscribers.delete(subscriber); };
        },
        /** @param {string} sessionId @param {string | null} color */
        async setSessionColor(sessionId, color) {
            if (typeof sessionId !== "string" || sessionId.length === 0)
                throw new TypeError("sessionId is required");
            return requestResult("set_session_color", { sessionId, color });
        },
        /** Every model the installed Pi will accept. Listing them runs no inference. */
        async getModels() {
            return (await requestResult("get_models", {})).models;
        },
        async getViewerSnapshot(sessionId) {
            if (typeof sessionId !== "string" || sessionId.length === 0)
                throw new TypeError("sessionId is required");
            return parseViewerSnapshot((await requestResult("get_viewer_snapshot", { sessionId })).snapshot);
        },
        subscribeViewer(sessionId, after) {
            if (typeof sessionId !== "string" || sessionId.length === 0)
                throw new TypeError("sessionId is required");
            if (after !== undefined && after.sessionId !== sessionId)
                throw new DaemonClientError("VIEWER_SESSION_MISMATCH", "Viewer cursor belongs to another session");
            const subscriber = { sessionId, resumeAfter: after, queue: [], ended: closed };
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
                ...subscriberIterable(subscriber, viewerSubscribers),
                /**
                 * Move the cursor this subscription resumes from after a reconnect. The daemon holds
                 * no viewer cursor for this client, so the consumer calls this once it has applied
                 * the event; a drop before that replays the event instead of skipping it.
                 */
                applied(cursor) { subscriber.resumeAfter = laterViewerCursor(subscriber.resumeAfter, cursor); },
            };
        },
        onFatalError(listener) {
            fatalErrorListeners.add(listener);
            return () => fatalErrorListeners.delete(listener);
        },
        /** Watch the control connection itself, so a dead daemon is visible instead of a frozen screen. */
        onConnectionChange(listener) {
            connectionListeners.add(listener);
            return () => connectionListeners.delete(listener);
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
            for (const subscriber of viewerSubscribers) {
                subscriber.ended = true;
                subscriber.waiter?.({ value: undefined, done: true });
                subscriber.waiter = undefined;
            }
            listSubscribers.clear();
            viewerSubscribers.clear();
            fatalErrorListeners.clear();
            connectionListeners.clear();
            if (socket !== undefined && !socket.destroyed) {
                await new Promise((resolve) => {
                    socket.once("close", resolve);
                    socket.destroy();
                });
            }
        },
    };
    return client;
}
