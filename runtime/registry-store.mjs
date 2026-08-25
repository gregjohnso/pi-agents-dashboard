import * as fs from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { atomicWriteJson } from "./atomic-file.mjs";
import { SessionCoordinator } from "./session-coordinator.mjs";

const CREATE_COORDINATION_KEY = "\0registry-create";
const TASK_STATES = new Set(["WORKING", "WAITING", "READY", "FAILED", "STOPPED"]);
const PROCESS_STATES = new Set(["LIVE", "SLEEPING", "EXITED", "STALE"]);
const OUTCOMES = new Set(["NONE", "COMPLETED", "READY_FOR_REVIEW"]);
const SESSION_RECORD_KEYS = [
  "schemaVersion",
  "revision",
  "sessionId",
  "sessionFile",
  "canonicalSessionFile",
  "cwd",
  "name",
  "model",
  "thinkingLevel",
  "taskState",
  "processState",
  "outcome",
  "activity",
  "ownership",
  "isolation",
  "latestRunId",
  "createdAt",
  "updatedAt",
];

/** @typedef {import("../shared/contracts.js").SessionRecord} SessionRecord */
/** @typedef {{ coordinator: SessionCoordinator }} RegistryCoordinationScope */

/** @type {Map<string, RegistryCoordinationScope>} */
const registryScopes = new Map();
/** @type {WeakMap<RegistryStore, RegistryCoordinationScope>} */
const storeScopes = new WeakMap();

/** A compare-and-swap revision mismatch. */
export class RegistryRevisionError extends Error {
  /** @param {string} sessionId @param {number} expectedRevision @param {number} actualRevision */
  constructor(sessionId, expectedRevision, actualRevision) {
    super(`Session ${sessionId} revision is ${actualRevision}, not ${expectedRevision}`);
    this.name = "RegistryRevisionError";
    this.code = "REVISION_CONFLICT";
    this.sessionId = sessionId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/** A canonical session file already represented by another record. */
export class CanonicalSessionConflictError extends Error {
  /** @param {string} canonicalSessionFile @param {string} existingSessionId */
  constructor(canonicalSessionFile, existingSessionId) {
    super(`Canonical session file already belongs to ${existingSessionId}`);
    this.name = "CanonicalSessionConflictError";
    this.code = "CANONICAL_SESSION_CONFLICT";
    this.canonicalSessionFile = canonicalSessionFile;
    this.existingSessionId = existingSessionId;
  }
}

/** A registry artifact that cannot be trusted as a session record. */
export class RegistryCorruptError extends Error {
  /** @param {string} path @param {unknown} cause */
  constructor(path, cause) {
    super(`Registry record is corrupt: ${path}`, { cause });
    this.name = "RegistryCorruptError";
    this.code = "REGISTRY_CORRUPT";
    this.path = path;
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {Record<string, any>} record @param {string} key @param {string} [path] */
function requireString(record, key, path = key) {
  if (typeof record[key] !== "string" || record[key].length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

/** @param {Record<string, any>} record @param {readonly string[]} allowed @param {string} path */
function rejectUnknownKeys(record, allowed, path) {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`Unknown ${path} field: ${unknown}`);
}

/** @param {unknown} value */
function validateProcessIdentity(value) {
  if (!isPlainObject(value)) throw new TypeError("ownership.process must be an object");
  rejectUnknownKeys(value, ["pid", "startIdentity", "processGroupId"], "ownership.process");
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new TypeError("ownership.process.pid must be a positive integer");
  }
  requireString(value, "startIdentity", "ownership.process.startIdentity");
  if (!Number.isSafeInteger(value.processGroupId) || value.processGroupId <= 0) {
    throw new TypeError("ownership.process.processGroupId must be a positive integer");
  }
}

/** @param {unknown} value */
function validateModel(value) {
  if (!isPlainObject(value)) throw new TypeError("model must be an object");
  rejectUnknownKeys(value, ["provider", "id"], "model");
  requireString(value, "provider", "model.provider");
  requireString(value, "id", "model.id");
}

/** @param {unknown} value */
function validateIsolation(value) {
  if (!isPlainObject(value)) throw new TypeError("isolation must be an object");
  if (value.mode === "worktree") {
    rejectUnknownKeys(value, ["mode", "worktreePath", "branch"], "isolation");
    requireString(value, "worktreePath", "isolation.worktreePath");
    requireString(value, "branch", "isolation.branch");
    return;
  }
  if (value.mode === "shared_directory") {
    rejectUnknownKeys(value, ["mode", "canonicalCwd"], "isolation");
    requireString(value, "canonicalCwd", "isolation.canonicalCwd");
    return;
  }
  throw new TypeError("isolation.mode is invalid");
}

/** @param {unknown} value @returns {SessionRecord} */
function validateRecord(value) {
  if (!isPlainObject(value)) throw new TypeError("Session record must be an object");
  rejectUnknownKeys(value, SESSION_RECORD_KEYS, "SessionRecord");
  if (value.schemaVersion !== 1) throw new TypeError("schemaVersion must be 1");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new TypeError("revision must be a non-negative integer");
  }
  for (const key of ["sessionId", "sessionFile", "canonicalSessionFile", "cwd", "createdAt", "updatedAt"]) {
    requireString(value, key);
  }
  validateSessionId(value.sessionId);
  if (!isAbsolute(value.canonicalSessionFile) || resolve(value.canonicalSessionFile) !== value.canonicalSessionFile) {
    throw new TypeError("canonicalSessionFile must be an absolute canonical path");
  }
  if (!TASK_STATES.has(value.taskState)) throw new TypeError("taskState is invalid");
  if (!PROCESS_STATES.has(value.processState)) throw new TypeError("processState is invalid");
  if (!OUTCOMES.has(value.outcome)) throw new TypeError("outcome is invalid");
  if (!isPlainObject(value.activity)) throw new TypeError("activity must be an object");
  rejectUnknownKeys(value.activity, ["kind", "summary", "updatedAt"], "activity");
  for (const key of ["kind", "summary", "updatedAt"]) requireString(value.activity, key, `activity.${key}`);

  if (value.name !== undefined) requireString(value, "name");
  if (value.model !== undefined) validateModel(value.model);
  if (value.thinkingLevel !== undefined) requireString(value, "thinkingLevel");
  if (value.latestRunId !== undefined) requireString(value, "latestRunId");
  if (value.isolation !== undefined) validateIsolation(value.isolation);
  if (value.ownership !== undefined) {
    if (!isPlainObject(value.ownership) || value.ownership.kind !== "managed") {
      throw new TypeError("ownership must be managed");
    }
    rejectUnknownKeys(
      value.ownership,
      ["kind", "runId", "process", "acquiredAt", "heartbeatAt"],
      "ownership",
    );
    for (const key of ["runId", "acquiredAt", "heartbeatAt"]) {
      requireString(value.ownership, key, `ownership.${key}`);
    }
    validateProcessIdentity(value.ownership.process);
  }
  return /** @type {SessionRecord} */ (value);
}

/** @param {string} sessionId */
function validateSessionId(sessionId) {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\0")
  ) {
    throw new TypeError("sessionId is not safe for a registry filename");
  }
}

/**
 * Return the directory-scoped coordination identity for one registry store.
 *
 * @param {RegistryStore} registry
 */
export function registryCoordinationScope(registry) {
  const scope = storeScopes.get(registry);
  if (scope === undefined) throw new TypeError("Expected a RegistryStore instance");
  return scope;
}

/** Atomic, compare-and-swap storage for canonical session records. */
export class RegistryStore {
  #sessionsDirectory;
  #fsOps;
  #atomicWrite;
  #coordinator;

  /**
   * @param {string} sessionsDirectory
   * @param {{ fsOps?: any, atomicWrite?: typeof atomicWriteJson, coordinator?: SessionCoordinator }} [options]
   */
  constructor(sessionsDirectory, options = {}) {
    if (typeof sessionsDirectory !== "string" || !isAbsolute(sessionsDirectory)) {
      throw new TypeError("Registry sessions directory must be an absolute path");
    }
    this.#sessionsDirectory = resolve(sessionsDirectory);
    this.#fsOps = options.fsOps ?? fs;
    this.#atomicWrite = options.atomicWrite ?? atomicWriteJson;
    let scope = registryScopes.get(this.#sessionsDirectory);
    if (scope === undefined) {
      scope = { coordinator: options.coordinator ?? new SessionCoordinator() };
      registryScopes.set(this.#sessionsDirectory, scope);
    }
    this.#coordinator = scope.coordinator;
    storeScopes.set(this, scope);
  }

  /** @param {string} sessionId */
  #path(sessionId) {
    validateSessionId(sessionId);
    return join(this.#sessionsDirectory, `${sessionId}.json`);
  }

  /** @param {string} path @param {string} expectedSessionId @returns {Promise<SessionRecord | undefined>} */
  async #readPath(path, expectedSessionId) {
    try {
      const metadata = await this.#fsOps.lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new TypeError("Registry record must be a regular file");
      }
      const record = validateRecord(JSON.parse(await this.#fsOps.readFile(path, "utf8")));
      if (record.sessionId !== expectedSessionId) {
        throw new TypeError("Registry filename and sessionId must match");
      }
      return record;
    } catch (error) {
      if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined;
      if (error instanceof RegistryCorruptError) throw error;
      throw new RegistryCorruptError(path, error);
    }
  }

  async list() {
    const names = await this.#fsOps.readdir(this.#sessionsDirectory);
    const records = await Promise.all(
      names
        .filter((/** @type {string} */ name) => name.endsWith(".json"))
        .sort()
        .map((/** @type {string} */ name) =>
          this.#readPath(join(this.#sessionsDirectory, name), name.slice(0, -".json".length)),
        ),
    );
    return records.filter((record) => record !== undefined);
  }

  /** @param {string} sessionId */
  async get(sessionId) {
    return this.#readPath(this.#path(sessionId), sessionId);
  }

  /** @param {SessionRecord} record */
  async create(record) {
    validateRecord(record);
    validateSessionId(record.sessionId);
    return this.#coordinator.run(CREATE_COORDINATION_KEY, async () => {
      if ((await this.get(record.sessionId)) !== undefined) {
        throw new RegistryRevisionError(record.sessionId, -1, record.revision);
      }
      const conflict = (await this.list()).find(
        (existing) => existing.canonicalSessionFile === record.canonicalSessionFile,
      );
      if (conflict !== undefined) {
        throw new CanonicalSessionConflictError(record.canonicalSessionFile, conflict.sessionId);
      }
      await this.#atomicWrite(this.#path(record.sessionId), record);
      return record;
    });
  }

  /** Remove one exact inactive record after a compare-and-swap revision check. @param {string} sessionId @param {number} expectedRevision */
  async remove(sessionId, expectedRevision) {
    validateSessionId(sessionId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("expectedRevision must be a non-negative integer");
    }
    return this.#coordinator.run(CREATE_COORDINATION_KEY, () =>
      this.#coordinator.run(sessionId, async () => {
        const current = await this.get(sessionId);
        if (current === undefined) return undefined;
        if (current.revision !== expectedRevision) {
          throw new RegistryRevisionError(sessionId, expectedRevision, current.revision);
        }
        await this.#fsOps.unlink(this.#path(sessionId));
        const directory = await this.#fsOps.open(this.#sessionsDirectory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return current;
      }),
    );
  }

  /** @param {string} sessionId @param {number} expectedRevision @param {Partial<SessionRecord>} update */
  async update(sessionId, expectedRevision, update) {
    validateSessionId(sessionId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("expectedRevision must be a non-negative integer");
    }
    if (!isPlainObject(update)) throw new TypeError("Registry update must be an object");

    return this.#coordinator.run(sessionId, async () => {
      const current = await this.get(sessionId);
      if (current === undefined) throw new Error(`Unknown registry session: ${sessionId}`);
      if (current.revision !== expectedRevision) {
        throw new RegistryRevisionError(sessionId, expectedRevision, current.revision);
      }
      if (
        (Object.hasOwn(update, "sessionId") && update.sessionId !== current.sessionId) ||
        (Object.hasOwn(update, "canonicalSessionFile") &&
          update.canonicalSessionFile !== current.canonicalSessionFile)
      ) {
        const error = new Error("Session ID and canonical session file are immutable");
        Object.assign(error, { code: "IMMUTABLE_SESSION_IDENTITY" });
        throw error;
      }

      const next = {
        ...current,
        ...update,
        sessionId: current.sessionId,
        canonicalSessionFile: current.canonicalSessionFile,
        revision: current.revision + 1,
      };
      validateRecord(next);
      await this.#atomicWrite(this.#path(sessionId), next);
      return next;
    });
  }
}
