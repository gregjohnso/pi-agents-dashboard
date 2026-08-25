import net from "node:net";
import { randomUUID } from "node:crypto";
import { createJsonlDecoder, createJsonlEncoder } from "../../runtime/jsonl.mjs";
import type { ClientRequest, DaemonResponse, EventCursor, PersistedEvent } from "../../shared/contracts.js";

export class DaemonClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DaemonClientError";
    this.code = code;
  }
}

type Pending = {
  request: ClientRequest;
  resolve(value: DaemonResponse): void;
  reject(error: unknown): void;
  promise: Promise<DaemonResponse>;
};
type Subscriber = {
  acknowledgedAfter?: EventCursor;
  queue: PersistedEvent[];
  waiter?: (value: IteratorResult<PersistedEvent>) => void;
  error?: Error;
  ended: boolean;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function laterCursor(current: EventCursor | undefined, candidate: EventCursor): EventCursor {
  if (current === undefined || current.daemonEpoch !== candidate.daemonEpoch) return candidate;
  if (!/^(0|[1-9]\d*)$/.test(current.sequence) || !/^(0|[1-9]\d*)$/.test(candidate.sequence)) return candidate;
  return BigInt(candidate.sequence) >= BigInt(current.sequence) ? candidate : current;
}

export interface DaemonClient {
  connect(): Promise<void>;
  request(request: ClientRequest): Promise<DaemonResponse>;
  subscribe(after?: EventCursor): AsyncIterable<PersistedEvent>;
  close(): Promise<void>;
}

export type DaemonClientOptions = {
  socketPath: string;
  token: string;
  maxBytes: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  clientId: string;
  subscriberLimit?: number;
};

/** Create a bounded JSONL daemon client that reconnects until explicitly closed. */
export function createDaemonClient({
  socketPath,
  token,
  maxBytes,
  reconnectDelayMs = 50,
  maxReconnectDelayMs = 1_000,
  clientId,
  subscriberLimit = 100,
}: DaemonClientOptions): DaemonClient {
  if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 0) throw new TypeError("reconnectDelayMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(maxReconnectDelayMs) || maxReconnectDelayMs < reconnectDelayMs) throw new TypeError("maxReconnectDelayMs must be at least reconnectDelayMs");
  if (!Number.isSafeInteger(subscriberLimit) || subscriberLimit < 1) throw new TypeError("subscriberLimit must be a positive safe integer");
  if (typeof clientId !== "string" || clientId.length === 0) throw new TypeError("clientId is required");

  const encoder = createJsonlEncoder({ maxBytes });
  const pending = new Map<string, Pending>();
  const seen = new Map<string, { canonical: string; response?: DaemonResponse }>();
  const subscribers = new Set<Subscriber>();
  const wakeDelays = new Set<() => void>();
  let socket: net.Socket | undefined;
  let reconnectLoop: Promise<void> | undefined;
  let closed = false;
  let authenticated = false;

  const hasWork = () => pending.size > 0 || subscribers.size > 0;
  const send = (value: unknown) => {
    if (socket === undefined || !authenticated || socket.destroyed) throw new DaemonClientError("NOT_CONNECTED", "Daemon is not connected");
    socket.write(encoder.encode(value));
  };
  const sendSubscriptions = () => {
    for (const subscriber of subscribers) {
      send({ version: 1, clientId, requestId: randomUUID(), op: "subscribe", payload: subscriber.acknowledgedAfter === undefined ? {} : { after: subscriber.acknowledgedAfter } });
    }
  };
  const dispatchEvent = (event: PersistedEvent) => {
    for (const subscriber of subscribers) {
      if (subscriber.ended) continue;
      if (subscriber.waiter !== undefined) {
        const waiter = subscriber.waiter;
        subscriber.waiter = undefined;
        waiter({ value: event, done: false });
      } else if (subscriber.queue.length >= subscriberLimit) {
        subscriber.error = new DaemonClientError("SUBSCRIBER_OVERFLOW", "Client subscriber exceeded its bounded queue");
        subscriber.ended = true;
        subscribers.delete(subscriber);
      } else {
        subscriber.queue.push(event);
      }
    }
  };
  const applyAcknowledgement = (cursor: EventCursor) => {
    for (const subscriber of subscribers) subscriber.acknowledgedAfter = laterCursor(subscriber.acknowledgedAfter, cursor);
  };
  const waitForRetry = (milliseconds: number) => new Promise<void>((resolve) => {
    if (closed || milliseconds === 0) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      clearTimeout(timer);
      wakeDelays.delete(wake);
      resolve();
    };
    timer = setTimeout(wake, milliseconds);
    wakeDelays.add(wake);
  });

  const attemptConnection = () => new Promise<void>((resolve, reject) => {
    if (closed) {
      reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
      return;
    }
    const candidate = net.createConnection(socketPath);
    socket = candidate;
    authenticated = false;
    const decoder = createJsonlDecoder({ maxBytes });
    let settled = false;
    const failAttempt = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    candidate.on("connect", () => candidate.write(encoder.encode({ version: 1, token })));
    candidate.on("data", (chunk) => {
      let records: unknown[];
      try {
        records = decoder.push(chunk);
      } catch (error) {
        failAttempt(error);
        candidate.destroy();
        return;
      }
      for (const record of records) {
        if (!authenticated) {
          if (typeof record === "object" && record !== null && (record as { kind?: unknown }).kind === "authenticated" && (record as { version?: unknown }).version === 1) {
            authenticated = true;
            try {
              for (const item of pending.values()) send(item.request);
              sendSubscriptions();
            } catch (error) {
              failAttempt(error);
              candidate.destroy();
              continue;
            }
            if (!settled) {
              settled = true;
              resolve();
            }
          } else {
            failAttempt(new DaemonClientError("AUTHENTICATION_FAILED", "Daemon rejected authentication"));
            candidate.destroy();
          }
          continue;
        }
        if (typeof record === "object" && record !== null && "cursor" in record && "kind" in record && "payload" in record) {
          dispatchEvent(record as PersistedEvent);
          continue;
        }
        if (typeof record !== "object" || record === null || typeof (record as { requestId?: unknown }).requestId !== "string") {
          candidate.destroy();
          continue;
        }
        const response = record as DaemonResponse;
        const item = pending.get(response.requestId);
        if (item === undefined) continue;
        pending.delete(response.requestId);
        const entry = seen.get(response.requestId);
        if (entry !== undefined) entry.response = response;
        if (item.request.op === "ack" && response.ok && response.result.kind === "acknowledged") applyAcknowledgement(response.result.cursor);
        item.resolve(response);
      }
    });
    candidate.on("error", failAttempt);
    candidate.on("close", () => {
      if (socket === candidate) {
        socket = undefined;
        authenticated = false;
      }
      failAttempt(new DaemonClientError("CONNECTION_CLOSED", "Daemon connection closed"));
      if (!closed && hasWork()) void startReconnectLoop().catch(() => {});
    });
  });

  function startReconnectLoop(): Promise<void> {
    if (closed) return Promise.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
    if (socket !== undefined && authenticated && !socket.destroyed) return Promise.resolve();
    if (reconnectLoop !== undefined) return reconnectLoop;
    reconnectLoop = (async () => {
      let retryDelay = reconnectDelayMs;
      while (!closed) {
        try {
          await attemptConnection();
          return;
        } catch {
          if (closed) break;
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
    request(request) {
      if (closed) return Promise.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
      if (request.clientId !== clientId) return Promise.reject(new DaemonClientError("CLIENT_ID_MISMATCH", "Request clientId does not match the configured daemon client identity"));
      const serialized = canonical(request);
      const previous = seen.get(request.requestId);
      if (previous !== undefined && previous.canonical !== serialized) return Promise.reject(new DaemonClientError("IDEMPOTENCY_CONFLICT", "Request IDs were reused with changed content"));
      if (previous?.response !== undefined) return Promise.resolve(previous.response);
      const existing = pending.get(request.requestId);
      if (existing !== undefined) return existing.promise;
      let resolve!: (value: DaemonResponse) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<DaemonResponse>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      pending.set(request.requestId, { request, resolve, reject, promise });
      seen.set(request.requestId, { canonical: serialized });
      if (socket !== undefined && authenticated && !socket.destroyed) send(request);
      else void startReconnectLoop().catch(() => {});
      return promise;
    },
    subscribe(after) {
      const subscriber: Subscriber = { acknowledgedAfter: after, queue: [], ended: false };
      subscribers.add(subscriber);
      if (socket !== undefined && authenticated && !socket.destroyed) {
        send({ version: 1, clientId, requestId: randomUUID(), op: "subscribe", payload: after === undefined ? {} : { after } });
      } else {
        void startReconnectLoop().catch(() => {});
      }
      const iterable: AsyncIterableIterator<PersistedEvent> = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (subscriber.error !== undefined) throw subscriber.error;
          const event = subscriber.queue.shift();
          if (event !== undefined) return { value: event, done: false };
          if (subscriber.ended) return { value: undefined, done: true };
          return new Promise<IteratorResult<PersistedEvent>>((resolve) => { subscriber.waiter = resolve; });
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
    async close() {
      if (closed) return;
      closed = true;
      for (const wake of wakeDelays) wake();
      for (const item of pending.values()) item.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
      pending.clear();
      for (const subscriber of subscribers) {
        subscriber.ended = true;
        subscriber.waiter?.({ value: undefined, done: true });
        subscriber.waiter = undefined;
      }
      subscribers.clear();
      if (socket !== undefined && !socket.destroyed) {
        await new Promise<void>((resolve) => {
          socket!.once("close", resolve);
          socket!.destroy();
        });
      }
    },
  };
}
