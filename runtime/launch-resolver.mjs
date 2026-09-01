import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { cleanupOwnedWorktree } from "../isolation/cleanup.mjs";
import { launchPreflight } from "../isolation/launch-preflight.mjs";
import { confirmSharedDirectory } from "../isolation/shared-directory.mjs";
import { createWorktree } from "../isolation/worktree.mjs";

/** @param {unknown} value @param {string} name */
function requiredId(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new TypeError(`${name} must be a non-empty identifier`);
  return value;
}

/** @param {any[]} records @param {string} canonicalCwd */
function activeSharedOwnerIds(records, canonicalCwd) {
  return records
    .filter((record) => record?.ownership !== undefined && (record.isolation?.mode === "shared_directory" ? record.isolation.canonicalCwd : record.cwd) === canonicalCwd)
    .map((record) => record.sessionId)
    .sort();
}

/** Derive a short, human session name from the first line of the launch prompt. @param {string} prompt */
export function sessionNameFromPrompt(prompt) {
  const firstLine = prompt.split(/\r?\n/u).map((line) => line.replace(/\s+/gu, " ").trim()).find((line) => line.length > 0);
  if (firstLine === undefined) return undefined;
  if (firstLine.length <= 48) return firstLine;
  const clipped = firstLine.slice(0, 48);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace >= 24 ? clipped.slice(0, lastSpace) : clipped).trim();
}

/** @param {string} prompt */
function activitySummary(prompt) {
  const plain = stripVTControlCharacters(prompt).replace(/[\r\n\u2028\u2029]/gu, " ").trim();
  return plain.length <= 160 ? plain : `${plain.slice(0, 159)}…`;
}

/** Materialize a valid public Pi session header at its canonical path. @param {string} cwd @param {string} preparedId @param {any} [options] */
export async function materializePiSession(cwd, preparedId, options = {}) {
  const createManager = options.createManager ?? ((/** @type {string} */ managerCwd, /** @type {string} */ sessionId) => SessionManager.create(managerCwd, undefined, { id: sessionId }));
  const openSession = options.openSession ?? ((/** @type {string} */ path, /** @type {string} */ managerCwd) => SessionManager.open(path, undefined, managerCwd));
  const manager = createManager(cwd, preparedId);
  const proposedPath = manager.getSessionFile();
  if (manager.getSessionId() !== preparedId || typeof proposedPath !== "string" || !isAbsolute(proposedPath)) throw new TypeError("Pi did not provide the requested persistent session identity");
  let created = false;
  try {
    const empty = await fs.open(proposedPath, "wx", 0o600);
    try { await empty.chmod(0o600); await empty.sync(); } finally { await empty.close(); }
    created = true;
    const opened = openSession(proposedPath, cwd);
    const sessionId = opened.getSessionId();
    const openedPath = opened.getSessionFile();
    if (typeof sessionId !== "string" || sessionId.length === 0 || openedPath !== proposedPath) throw new TypeError("Materialized Pi session identity changed unexpectedly");
    const handle = await fs.open(proposedPath, "r");
    let metadata;
    let header;
    try {
      await handle.sync();
      metadata = await handle.stat();
      header = JSON.parse((await handle.readFile("utf8")).split("\n", 1)[0]);
    } finally { await handle.close(); }
    const canonicalDirectory = await fs.realpath(dirname(proposedPath));
    const sessionFile = join(canonicalDirectory, basename(proposedPath));
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || header?.type !== "session" || header.id !== sessionId || header.cwd !== cwd) throw new TypeError("Materialized Pi session header is invalid");
    return { sessionId, sessionFile, identity: { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeMs: metadata.mtimeMs } };
  } catch (error) {
    if (created) await fs.rm(proposedPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** @param {string} sessionFile @param {any} expected @param {any} fsOps */
async function removePreparedSession(sessionFile, expected, fsOps) {
  if (typeof expected !== "object" || expected === null) throw new TypeError("Prepared session identity is unavailable");
  const metadata = await fsOps.lstat(sessionFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev !== expected.dev || metadata.ino !== expected.ino || metadata.size !== expected.size || metadata.mtimeMs !== expected.mtimeMs) throw Object.assign(new Error("Prepared session identity changed"), { code: "SESSION_IDENTITY_CHANGED" });
  await fsOps.unlink(sessionFile);
  const directory = await fsOps.open(dirname(sessionFile), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Resolve one strict daemon launch into isolation, registry identity, and worker inputs. @param {any} options */
export function createLaunchResolver({
  registry,
  piConfigRoot,
  preflight = launchPreflight,
  createWorktree: createIsolatedWorktree = createWorktree,
  cleanupWorktree: cleanupPreparedWorktree = cleanupOwnedWorktree,
  confirmSharedDirectory: confirmShared = confirmSharedDirectory,
  createPiSession = materializePiSession,
  canonicalizeCwd = fs.realpath,
  randomId = randomUUID,
  now = () => new Date().toISOString(),
}) {
  if (typeof registry?.list !== "function") throw new TypeError("Launch resolver requires a registry");
  if (typeof piConfigRoot !== "string" || !isAbsolute(piConfigRoot) || resolve(piConfigRoot) !== piConfigRoot) throw new TypeError("Pi configuration root must be an absolute canonical path");
  if ([preflight, createIsolatedWorktree, cleanupPreparedWorktree, confirmShared, createPiSession, canonicalizeCwd, randomId, now].some((dependency) => typeof dependency !== "function")) throw new TypeError("Launch resolver dependencies must be functions");

  return async (/** @type {any} */ request) => {
    const payload = request?.payload;
    if (typeof payload !== "object" || payload === null || typeof payload.prompt !== "string" || payload.prompt.trim().length === 0) throw new TypeError("Launch request payload is invalid");
    const checked = await preflight(payload, { piConfigRoot, currentOwnerSessionIds: [] });
    const preparedId = requiredId(randomId(), "Prepared launch ID");
    const runId = requiredId(randomId(), "Run ID");
    // The run directory is named before the record exists, so the prepared row already resolves its
    // own diagnostics under whatever state root currently holds it.
    const runHash = createHash("sha256").update(`${runId}\0${preparedId}`).digest("hex");
    /** @type {any} */
    let isolation;
    if (checked.mode === "worktree") {
      isolation = await createIsolatedWorktree(checked, { worktreeId: preparedId });
    } else if (checked.mode === "shared_directory_confirmation") {
      isolation = await confirmShared(checked, {
        currentOwnerSessionIds: activeSharedOwnerIds(await registry.list(), checked.canonicalCwd),
      });
    } else {
      throw new TypeError("Launch preflight returned an unsupported isolation mode");
    }
    /** @type {any} */
    let piSession;
    try {
      const workerCwd = await canonicalizeCwd(isolation.workerCwd);
      piSession = await createPiSession(workerCwd, preparedId);
      const sessionId = requiredId(piSession?.sessionId, "Pi session ID");
      if (typeof piSession.sessionFile !== "string" || !isAbsolute(piSession.sessionFile) || resolve(piSession.sessionFile) !== piSession.sessionFile) throw new TypeError("Pi session identity is invalid");
      const timestamp = now();
      /** @type {import("../shared/contracts.mjs").SessionRecord} */
      const sessionRecord = {
        schemaVersion: 1,
        revision: 0,
        sessionId,
        sessionFile: piSession.sessionFile,
        canonicalSessionFile: piSession.sessionFile,
        cwd: workerCwd,
        taskState: "READY",
        processState: "EXITED",
        outcome: "NONE",
        activity: { kind: "launching", summary: activitySummary(payload.prompt), updatedAt: timestamp },
        isolation: isolation.mode === "worktree"
          ? { mode: "worktree", worktreePath: isolation.worktreePath, branch: isolation.branch }
          : { mode: "shared_directory", canonicalCwd: isolation.canonicalCwd },
        latestRunId: runId,
        runHash,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      // A name derived from the prompt is a placeholder, so the summary pass may replace it;
      // only a name the operator typed outranks a generated one.
      const name = payload.name ?? sessionNameFromPrompt(payload.prompt);
      if (name !== undefined) {
        sessionRecord.name = name;
        sessionRecord.nameGenerated = payload.name === undefined;
      }
      // Only the worker receives the requested model. The row records the model Pi confirms at
      // readiness, so a launch that dies first shows no model rather than one it never ran.
      return {
        sessionId,
        canonicalSessionFile: piSession.sessionFile,
        cwd: workerCwd,
        runId,
        runHash,
        initialPrompt: payload.prompt,
        sessionRecord,
        ...(payload.model === undefined ? {} : { model: { ...payload.model } }),
        ...(name === undefined ? {} : { name }),
      };
    } catch (error) {
      try {
        if (isolation.mode === "worktree") await cleanupPreparedWorktree(isolation, { readLiveOwnership: async () => undefined });
        if (piSession?.identity !== undefined && typeof piSession.sessionFile === "string") await removePreparedSession(piSession.sessionFile, piSession.identity, fs);
      } catch (rollbackError) {
        throw Object.assign(new Error("Prepared launch cleanup failed", { cause: rollbackError }), { code: "LAUNCH_PREPARATION_ROLLBACK_FAILED" });
      }
      throw error;
    }
  };
}
