import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { inspectDaemonEndpoint } from "./daemon-lifecycle.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";

/** @param {string} path */
async function exists(path) { try { await access(path); return true; } catch { return false; } }

/** @param {any} value */
function validProcessIdentity(value) { return Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value.startIdentity === "string" && value.startIdentity.length > 0 && Number.isSafeInteger(value.processGroupId) && value.processGroupId > 0; }
/** @param {any} left @param {any} right */
function sameProcessIdentity(left, right) { return left?.pid === right.pid && left?.startIdentity === right.startIdentity && left?.processGroupId === right.processGroupId; }

/**
 * Inspect exact daemon and supervisor identities under one state root without treating stale
 * metadata as live.
 *
 * A published daemon counts as active for both HEALTHY and UNHEALTHY, because both mean the
 * published PID still matches a live process with the same start identity; only the socket probe
 * separates them. `unverifiable` reports a root whose holders cannot be read at all, so a caller
 * that must fail closed can refuse instead of assuming the root is idle.
 *
 * @param {{ stateRoot: string, runtimeRoot?: string, exists?: (path: string) => Promise<boolean>, inspectEndpoint?: (options: { root: string, inspect: (pid: number) => Promise<any> }) => Promise<any>, inspect?: (pid: number) => Promise<any>, readFile?: (path: string, encoding: "utf8") => Promise<string> }} options
 * @returns {Promise<{ activeDaemon: false | Record<string, any>, activeSupervisors: any[], unverifiable: boolean }>}
 */
export async function inspectRuntimeActivity({ stateRoot, runtimeRoot = stateRoot, exists: pathExists = exists, inspectEndpoint = inspectDaemonEndpoint, inspect = inspectProcessIdentity, readFile: read = readFile }) {
  /** @type {false | Record<string, any>} */
  let activeDaemon = false;
  let unverifiable = false;
  if (await pathExists(runtimeRoot)) {
    const endpoint = await inspectEndpoint({ root: runtimeRoot, inspect });
    if (["HEALTHY", "UNHEALTHY"].includes(endpoint.status)) activeDaemon = endpoint.publication;
    if (endpoint.status === "CONFLICT") unverifiable = true;
  }
  let value;
  try { value = JSON.parse(await read(join(stateRoot, "daemon", "workers.json"), "utf8")); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return { activeDaemon, activeSupervisors: [], unverifiable }; throw error; }
  if (value?.schemaVersion !== 1 || !Array.isArray(value.workers) || Object.keys(value).some((key) => !["schemaVersion", "workers"].includes(key))) throw new TypeError("Worker metadata is invalid");
  const activeSupervisors = [];
  for (const worker of value.workers) {
    const identity = worker?.identity;
    const allowed = ["sessionId", "runId", "leaseId", "generation", "identity", "piChildIdentity", "token", "proto", "cliVersion", "routeGeneration"];
    // A run reserved before its spawn has no identity yet, so it names no supervisor to inspect.
    const bound = identity !== undefined || worker?.piChildIdentity !== undefined;
    if (typeof worker !== "object" || worker === null || Object.keys(worker).some((key) => !allowed.includes(key)) || [worker.sessionId, worker.runId, worker.leaseId].some((entry) => typeof entry !== "string" || entry.length === 0) || !Number.isSafeInteger(worker.generation) || worker.generation <= 0 || (bound && (!validProcessIdentity(identity) || !validProcessIdentity(worker.piChildIdentity)))) throw new TypeError("Worker metadata record is invalid");
    if (!bound) continue;
    try { const actual = await inspect(identity.pid); if (sameProcessIdentity(actual, identity)) activeSupervisors.push(identity); }
    catch (error) { if (!["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) throw error; }
  }
  return { activeDaemon, activeSupervisors, unverifiable };
}
