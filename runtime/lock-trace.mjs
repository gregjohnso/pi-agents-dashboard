import { appendFileSync } from "node:fs";

// Per-session lock tracing for perf/transition-latency.mjs, which sets PI_DASHBOARD_DAEMON_PERF_LOG.
// Off by default: an unset variable makes traceSessionLock return the operation's own promise untouched.
const destination = process.env.PI_DASHBOARD_DAEMON_PERF_LOG ?? "";

/** True when a run asked for per-session lock traces. */
export const lockTraceEnabled = destination.length > 0;

/**
 * Run one coordinated operation, recording how long it queued and how long it held the key.
 *
 * @template Result
 * @param {string} label call-site name, so one queue's holders can be told apart
 * @param {string} key the coordination key, normally a session ID
 * @param {(operation: () => Promise<Result> | Result) => Promise<Result>} acquire
 * @param {() => Promise<Result> | Result} operation
 * @returns {Promise<Result>}
 */
export function traceSessionLock(label, key, acquire, operation) {
  if (!lockTraceEnabled) return acquire(operation);
  const requestedAt = performance.now();
  return acquire(async () => {
    const acquiredAt = performance.now();
    try {
      return await operation();
    } finally {
      const releasedAt = performance.now();
      try {
        appendFileSync(destination, `${JSON.stringify({ label, key, waitMs: acquiredAt - requestedAt, holdMs: releasedAt - acquiredAt, at: Date.now() })}\n`);
      } catch {}
    }
  });
}
