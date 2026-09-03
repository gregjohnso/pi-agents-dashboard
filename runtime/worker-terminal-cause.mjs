import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteJson } from "./atomic-file.mjs";

export const WORKER_TERMINAL_CAUSE_FILE = "terminal-cause.json";

/** @param {unknown} value */
function validIdentity(value) {
  const identity = /** @type {any} */ (value);
  return typeof value === "object" && value !== null && !Array.isArray(value) && Number.isSafeInteger(identity.pid) && identity.pid > 0 && typeof identity.startIdentity === "string" && identity.startIdentity.length > 0 && Number.isSafeInteger(identity.processGroupId) && identity.processGroupId > 0;
}

/** @param {any} left @param {any} right */
function sameIdentity(left, right) {
  return validIdentity(left) && validIdentity(right) && left.pid === right.pid && left.startIdentity === right.startIdentity && left.processGroupId === right.processGroupId;
}

/** @param {unknown} value */
function validTimestamp(value) {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

/**
 * Every field a published terminal cause must carry, with no binding to the run that produced it.
 * A reader that holds the run's identities checks those separately; a reader that only moves the
 * file, like a state-root migration, has nothing to bind it to and validates this alone.
 * @param {any} cause
 */
export function validWorkerTerminalCauseShape(cause) {
  const keys = ["schemaVersion", "sessionId", "runId", "leaseId", "generation", "worker", "piChild", "event"];
  const eventKeys = ["type", "at", "summary"];
  return typeof cause === "object" && cause !== null && !Array.isArray(cause) &&
    Object.keys(cause).every((key) => keys.includes(key)) && Object.keys(cause).length === keys.length &&
    cause.schemaVersion === 1 &&
    [cause.sessionId, cause.runId, cause.leaseId].every((value) => typeof value === "string" && value.length > 0) &&
    Number.isSafeInteger(cause.generation) && cause.generation > 0 &&
    validIdentity(cause.worker) && validIdentity(cause.piChild) &&
    typeof cause.event === "object" && cause.event !== null && !Array.isArray(cause.event) &&
    Object.keys(cause.event).every((key) => eventKeys.includes(key)) && Object.keys(cause.event).length === eventKeys.length &&
    cause.event.type === "PI_CHILD_CRASHED" && validTimestamp(cause.event.at) &&
    typeof cause.event.summary === "string" && cause.event.summary.length > 0 && cause.event.summary.length <= 1024;
}

/** @param {any} cause @param {{ sessionId: string, runId: string, leaseId: string, generation: number, worker: any, piChild: any }} expected */
export function validWorkerTerminalCause(cause, expected) {
  return validWorkerTerminalCauseShape(cause) &&
    cause.sessionId === expected.sessionId && cause.runId === expected.runId &&
    cause.leaseId === expected.leaseId && cause.generation === expected.generation &&
    sameIdentity(cause.worker, expected.worker) && sameIdentity(cause.piChild, expected.piChild);
}

/** @param {string} root @param {string} runHash */
export function workerTerminalCausePath(root, runHash) {
  return join(root, "runs", runHash, WORKER_TERMINAL_CAUSE_FILE);
}

/** @param {string} path @param {unknown} cause */
export async function publishWorkerTerminalCause(path, cause) {
  await atomicWriteJson(path, cause);
}

/**
 * Read only a private, owned regular file, and say whether a record was published at all. A worker
 * from a build that predates this format publishes nothing, which reads as absent; a record that is
 * present and malformed, unsafe, or bound to other identities is refused, never mistaken for absence.
 * @param {string} path
 * @param {{ sessionId: string, runId: string, leaseId: string, generation: number, worker: any, piChild: any }} expected
 * @returns {Promise<{ present: boolean, cause: any }>}
 */
export async function inspectWorkerTerminalCause(path, expected) {
  let handle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // ENOENT is the only refusal that proves nothing was published: ELOOP, EACCES and the rest are files.
    return { present: /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT", cause: undefined };
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) return { present: true, cause: undefined };
    const cause = JSON.parse(await handle.readFile("utf8"));
    return { present: true, cause: validWorkerTerminalCause(cause, expected) ? cause : undefined };
  } catch {
    return { present: true, cause: undefined };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Read only a private, owned regular file and return no cause for every invalid record.
 * @param {string} path
 * @param {{ sessionId: string, runId: string, leaseId: string, generation: number, worker: any, piChild: any }} expected
 */
export async function readWorkerTerminalCause(path, expected) {
  return (await inspectWorkerTerminalCause(path, expected)).cause;
}

/** @param {string} path */
export async function retireWorkerTerminalCause(path) {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return;
    throw error;
  }
  const directory = await fs.open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
