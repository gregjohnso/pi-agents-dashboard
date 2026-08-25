import net from "node:net";
import { randomUUID } from "node:crypto";
import { createJsonlDecoder, createJsonlEncoder } from "../../runtime/jsonl.mjs";
import type { ClientRequest, DaemonResponse, EventCursor, PersistedEvent } from "../../shared/contracts.js";

export class DaemonClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "DaemonClientError"; this.code = code; }
}
type Pending = { request: ClientRequest; resolve(value: DaemonResponse): void; reject(error: unknown): void; promise: Promise<DaemonResponse> };
type Subscriber = { after?: EventCursor; queue: PersistedEvent[]; waiter?: (value: IteratorResult<PersistedEvent>) => void; error?: Error; ended: boolean };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export interface DaemonClient {
  connect(): Promise<void>;
  request(request: ClientRequest): Promise<DaemonResponse>;
  subscribe(after?: EventCursor): AsyncIterable<PersistedEvent>;
  close(): Promise<void>;
}

/** Create a bounded JSONL daemon client that reconnects and retries exact request IDs. */
export function createDaemonClient({ socketPath, token, maxBytes, reconnectDelayMs = 50, clientId = randomUUID(), subscriberLimit = 100 }: { socketPath: string; token: string; maxBytes: number; reconnectDelayMs?: number; clientId?: string; subscriberLimit?: number }): DaemonClient {
  const encoder = createJsonlEncoder({ maxBytes });
  const pending = new Map<string, Pending>();
  const seen = new Map<string, { canonical: string; response?: DaemonResponse }>();
  const subscribers = new Set<Subscriber>();
  let socket: net.Socket | undefined; let connectPromise: Promise<void> | undefined; let closed = false; let authenticated = false;

  const send = (value: unknown) => { if (!socket || !authenticated || socket.destroyed) throw new DaemonClientError("NOT_CONNECTED", "Daemon is not connected"); socket.write(encoder.encode(value)); };
  const dispatchEvent = (event: PersistedEvent) => {
    for (const subscriber of subscribers) {
      if (subscriber.ended) continue;
      subscriber.after = event.cursor;
      if (subscriber.waiter) { const waiter = subscriber.waiter; subscriber.waiter = undefined; waiter({ value: event, done: false }); }
      else if (subscriber.queue.length >= subscriberLimit) { subscriber.error = new DaemonClientError("SUBSCRIBER_OVERFLOW", "Client subscriber exceeded its bounded queue"); subscriber.ended = true; }
      else subscriber.queue.push(event);
    }
  };
  const establish = () => {
    if (closed) return Promise.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
    if (socket && authenticated && !socket.destroyed) return Promise.resolve();
    if (connectPromise) return connectPromise;
    connectPromise = new Promise<void>((resolve, reject) => {
      const candidate = net.createConnection(socketPath); socket = candidate; authenticated = false; const decoder = createJsonlDecoder({ maxBytes }); let settled = false;
      const failConnect = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
      candidate.on("connect", () => candidate.write(encoder.encode({ version: 1, token })));
      candidate.on("data", (chunk) => {
        let records: unknown[]; try { records = decoder.push(chunk); } catch (error) { candidate.destroy(); failConnect(error); return; }
        for (const record of records) {
          if (!authenticated) {
            if (typeof record === "object" && record !== null && (record as { kind?: unknown }).kind === "authenticated" && (record as { version?: unknown }).version === 1) {
              authenticated = true; settled = true; resolve();
              for (const item of pending.values()) send(item.request);
              for (const subscriber of subscribers) send({ version: 1, clientId, requestId: randomUUID(), op: "subscribe", payload: subscriber.after ? { after: subscriber.after } : {} });
            } else { const error = new DaemonClientError("AUTHENTICATION_FAILED", "Daemon rejected authentication"); candidate.destroy(); failConnect(error); }
            continue;
          }
          if (typeof record === "object" && record !== null && "cursor" in record && "kind" in record && "payload" in record) { dispatchEvent(record as PersistedEvent); continue; }
          if (typeof record !== "object" || record === null || typeof (record as { requestId?: unknown }).requestId !== "string") { candidate.destroy(); continue; }
          const response = record as DaemonResponse;
          const match = [...pending.entries()].find(([, item]) => item.request.requestId === response.requestId);
          if (match) { const [identity, item] = match; pending.delete(identity); const entry = seen.get(identity); if (entry) entry.response = response; item.resolve(response); }
        }
      });
      candidate.on("error", failConnect);
      candidate.on("close", () => {
        if (socket === candidate) { socket = undefined; authenticated = false; }
        failConnect(new DaemonClientError("CONNECTION_CLOSED", "Daemon connection closed"));
        if (!closed && (pending.size > 0 || subscribers.size > 0)) void delay(reconnectDelayMs).then(establish).catch((error) => { for (const item of pending.values()) item.reject(error); pending.clear(); });
      });
    }).finally(() => { connectPromise = undefined; });
    return connectPromise;
  };

  return {
    connect: establish,
    request(request) {
      if (closed) return Promise.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
      const identity = `${request.clientId}\u0000${request.requestId}`; const serialized = canonical(request); const previous = seen.get(identity);
      if (previous && previous.canonical !== serialized) return Promise.reject(new DaemonClientError("IDEMPOTENCY_CONFLICT", "Request IDs were reused with changed content"));
      if (previous?.response) return Promise.resolve(previous.response);
      const existing = pending.get(identity); if (existing) return existing.promise;
      let resolve!: (value: DaemonResponse) => void; let reject!: (error: unknown) => void;
      const promise = new Promise<DaemonResponse>((yes, no) => { resolve = yes; reject = no; });
      const item = { request, resolve, reject, promise }; pending.set(identity, item); seen.set(identity, { canonical: serialized });
      if (socket && authenticated && !socket.destroyed) send(request);
      else void establish().catch((error) => { if (pending.delete(identity)) reject(error); });
      return promise;
    },
    subscribe(after) {
      const subscriber: Subscriber = { after, queue: [], ended: false }; subscribers.add(subscriber); void establish().catch((error) => { subscriber.error = error as Error; subscriber.ended = true; });
      const iterable: AsyncIterableIterator<PersistedEvent> = { [Symbol.asyncIterator]() { return this; }, async next() { if (subscriber.error) throw subscriber.error; if (subscriber.queue.length) return { value: subscriber.queue.shift()!, done: false as const }; if (subscriber.ended) return { value: undefined, done: true as const }; return new Promise<IteratorResult<PersistedEvent>>((resolve) => { subscriber.waiter = resolve; }); }, async return() { subscriber.ended = true; subscribers.delete(subscriber); subscriber.waiter?.({ value: undefined, done: true }); return { value: undefined, done: true as const }; } };
      return iterable;
    },
    async close() { closed = true; for (const item of pending.values()) item.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed")); pending.clear(); for (const subscriber of subscribers) { subscriber.ended = true; subscriber.waiter?.({ value: undefined, done: true }); } subscribers.clear(); if (socket) await new Promise<void>((resolve) => { socket!.once("close", resolve); socket!.destroy(); }); },
  };
}
