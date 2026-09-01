import { appendFileSync } from "node:fs";

// The one launch instant perf/cold-launch.mjs cannot recover from durable state, recorded when
// PI_AGENTS_LAUNCH_TRACE names a destination. Off by default: an unset variable makes
// recordLaunchStage return without touching the filesystem. The destination is read per call, not
// cached, so a measurement can enable it after this module is imported.
//
// Every other instant a cold-launch sample needs is already durable or already on the measuring
// client's clock and needs no hook: worker and Pi child spawn from the process start ticks in the
// session record's ownership and runtime identities, and the launch request and the first usable
// viewer snapshot from the client that sent them. Readiness persistence has no durable trace,
// because the row's `updatedAt` moves on as soon as the first turn starts.

/** The launch stages a run may be asked to record. Named for what happened, not for its transport. */
/** @typedef {"ready_persisted"} LaunchStage */

/**
 * Record the wall-clock instant one launch stage completed.
 *
 * Epoch milliseconds, not `performance.now()`: the measuring process compares these against its own
 * clock and against timestamps written by other processes.
 *
 * @param {LaunchStage} stage
 * @param {string} sessionId
 */
export function recordLaunchStage(stage, sessionId) {
  const destination = process.env.PI_AGENTS_LAUNCH_TRACE ?? "";
  if (destination.length === 0) return;
  try {
    appendFileSync(destination, `${JSON.stringify({ stage, sessionId, at: Date.now() })}\n`);
  } catch {}
}
