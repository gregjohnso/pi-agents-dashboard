import { randomUUID } from "node:crypto";

import { acquireWorktreeOwnershipLock } from "../isolation/worktree.mjs";
import { registryCoordinationScope } from "./registry-store.mjs";
import { SessionCoordinator } from "./session-coordinator.mjs";

/** @typedef {import("../shared/contracts.mjs").ProcessIdentity} ProcessIdentity */
/**
 * @typedef {object} WriterLease
 * @property {string} sessionId
 * @property {string} canonicalSessionFile
 * @property {string} runId
 * @property {string} leaseId
 * @property {number} generation
 * @property {string} acquiredAt
 * @property {ProcessIdentity} [worker]
 * @property {ProcessIdentity} [piChild]
 */
/**
 * @typedef {object} OwnershipState
 * @property {Map<string, WriterLease>} leases
 * @property {Map<string, number>} generations
 * @property {SessionCoordinator} coordinator
 */

/** @type {WeakMap<object, OwnershipState>} */
const ownershipStates = new WeakMap();

/** A visible refusal to create a second session-file writer. */
export class OwnershipConflictError extends Error {
  /** @param {string} sessionId @param {string} ownerRunId */
  constructor(sessionId, ownerRunId) {
    super(`Session ${sessionId} already has a writer`);
    this.name = "OwnershipConflictError";
    this.code = "OWNERSHIP_CONFLICT";
    this.sessionId = sessionId;
    this.ownerRunId = ownerRunId;
  }
}

/** A delayed hello or release from a superseded lease. */
export class StaleLeaseError extends Error {
  /** @param {string} sessionId @param {string} leaseId @param {number} generation */
  constructor(sessionId, leaseId, generation) {
    super(`Lease ${leaseId} generation ${generation} is stale for session ${sessionId}`);
    this.name = "StaleLeaseError";
    this.code = "STALE_LEASE";
    this.sessionId = sessionId;
    this.leaseId = leaseId;
    this.generation = generation;
  }
}

/** @param {unknown} identity @param {string} label @returns {asserts identity is ProcessIdentity} */
function validateIdentity(identity, label) {
  if (typeof identity !== "object" || identity === null) {
    throw new TypeError(`${label} must be a complete process identity`);
  }
  const candidate = /** @type {Record<string, unknown>} */ (identity);
  if (
    !Number.isSafeInteger(candidate.pid) ||
    /** @type {number} */ (candidate.pid) <= 0 ||
    typeof candidate.startIdentity !== "string" ||
    candidate.startIdentity.length === 0 ||
    !Number.isSafeInteger(candidate.processGroupId) ||
    /** @type {number} */ (candidate.processGroupId) <= 0
  ) {
    throw new TypeError(`${label} must be a complete process identity`);
  }
}

/** @param {ProcessIdentity} a @param {ProcessIdentity} b */
function sameIdentity(a, b) {
  return (
    a.pid === b.pid &&
    a.startIdentity === b.startIdentity &&
    a.processGroupId === b.processGroupId
  );
}

/** @param {import("../shared/contracts.mjs").SessionRecord | undefined} record @param {WriterLease} lease */
function hasLeaseOwnership(record, lease) {
  if (
    record?.ownership === undefined ||
    record.ownership.runId !== lease.runId ||
    record.ownership.acquiredAt !== lease.acquiredAt
  ) {
    return false;
  }
  return lease.worker === undefined || sameIdentity(record.ownership.process, lease.worker);
}

/** Acquire and manage generation-bearing writer leases for canonical session files. */
export class OwnershipManager {
  #registry;
  #now;
  #randomId;
  /** @type {OwnershipState} */
  #state;

  /**
   * @param {import("./registry-store.mjs").RegistryStore} registry
   * @param {{ now?: () => string, randomId?: () => string, coordinator?: SessionCoordinator }} [options]
   */
  constructor(registry, options = {}) {
    this.#registry = registry;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomId = options.randomId ?? randomUUID;

    const scope = registryCoordinationScope(registry);
    let state = ownershipStates.get(scope);
    if (state === undefined) {
      state = {
        leases: new Map(),
        generations: new Map(),
        coordinator: options.coordinator ?? registryCoordinationScope(registry).lifecycle,
      };
      ownershipStates.set(scope, state);
    }
    this.#state = state;
  }

  /**
   * Run every ownership mutation under the session lifecycle lock, then the Task 9 worktree lock.
   * Cleanup takes only the worktree lock and performs read-only daemon queries, so it never waits
   * for the lifecycle lock while holding the worktree lock.
   * @param {string} sessionId @param {() => Promise<any>} action
   */
  #runWithOwnershipLock(sessionId, action) {
    return this.#state.coordinator.runNested(sessionId, async () => {
      const record = await this.#registry.get(sessionId);
      if (record?.isolation?.mode !== "worktree") return action();
      const lock = await acquireWorktreeOwnershipLock(record.isolation.worktreePath);
      try {
        return await action();
      } finally {
        await lock.release();
      }
    });
  }

  /** @param {string} sessionId @param {string} leaseId @param {number} generation @returns {WriterLease} */
  #currentLease(sessionId, leaseId, generation) {
    const lease = this.#state.leases.get(sessionId);
    if (
      lease === undefined ||
      lease.leaseId !== leaseId ||
      lease.generation !== generation
    ) {
      throw new StaleLeaseError(sessionId, leaseId, generation);
    }
    return lease;
  }

  /** @param {string} sessionId @param {string} canonicalSessionFile @param {string} runId */
  async acquire(sessionId, canonicalSessionFile, runId) {
    if (typeof runId !== "string" || runId.length === 0) {
      throw new TypeError("runId must be a non-empty string");
    }
    return this.#runWithOwnershipLock(sessionId, async () => {
      const record = await this.#registry.get(sessionId);
      if (record === undefined) throw new Error(`Unknown registry session: ${sessionId}`);
      if (record.canonicalSessionFile !== canonicalSessionFile) {
        const error = new Error("Ownership requires the registry's canonical session file");
        Object.assign(error, {
          code: "CANONICAL_SESSION_MISMATCH",
          sessionId,
          canonicalSessionFile: record.canonicalSessionFile,
          requestedCanonicalSessionFile: canonicalSessionFile,
        });
        throw error;
      }

      const pending = this.#state.leases.get(sessionId);
      if (pending !== undefined) {
        throw new OwnershipConflictError(sessionId, pending.runId);
      }
      if (record.ownership !== undefined) {
        throw new OwnershipConflictError(sessionId, record.ownership.runId);
      }

      const generation = (this.#state.generations.get(sessionId) ?? 0) + 1;
      /** @type {WriterLease} */
      const lease = {
        sessionId,
        canonicalSessionFile,
        runId,
        leaseId: this.#randomId(),
        generation,
        acquiredAt: this.#now(),
      };
      if (typeof lease.leaseId !== "string" || lease.leaseId.length === 0) {
        throw new TypeError("Lease ID generator must return a non-empty string");
      }
      this.#state.generations.set(sessionId, generation);
      this.#state.leases.set(sessionId, lease);
      return { ...lease };
    });
  }

  /** @param {string} sessionId @param {string} leaseId @param {number} generation @param {unknown} worker @param {unknown} piChild */
  async bindProcesses(sessionId, leaseId, generation, worker, piChild) {
    validateIdentity(worker, "worker");
    validateIdentity(piChild, "piChild");
    return this.#runWithOwnershipLock(sessionId, async () => {
      const lease = this.#currentLease(sessionId, leaseId, generation);
      if (lease.worker !== undefined) throw new OwnershipConflictError(sessionId, lease.runId);
      const record = await this.#registry.get(sessionId);
      if (record === undefined) throw new Error(`Unknown registry session: ${sessionId}`);
      if (record.ownership !== undefined) {
        throw new OwnershipConflictError(sessionId, record.ownership.runId);
      }

      const ownership = {
        kind: /** @type {const} */ ("managed"),
        runId: lease.runId,
        process: worker,
        acquiredAt: lease.acquiredAt,
        heartbeatAt: lease.acquiredAt,
      };
      try {
        await this.#registry.update(sessionId, record.revision, {
          latestRunId: lease.runId,
          processState: "LIVE",
          updatedAt: lease.acquiredAt,
          ownership,
        });
      } catch (error) {
        const committed = await this.#registry.get(sessionId);
        if (
          committed?.revision !== record.revision + 1 ||
          committed.processState !== "LIVE" ||
          committed.latestRunId !== lease.runId ||
          !hasLeaseOwnership(committed, { ...lease, worker })
        ) {
          throw error;
        }
      }
      lease.worker = worker;
      lease.piChild = piChild;
      return { ...lease };
    });
  }

  /** @param {string} sessionId @param {string} leaseId @param {number} generation */
  async heartbeat(sessionId, leaseId, generation) {
    return this.#runWithOwnershipLock(sessionId, async () => {
      const lease = this.#currentLease(sessionId, leaseId, generation);
      if (lease.worker === undefined) throw new StaleLeaseError(sessionId, leaseId, generation);
      const record = await this.#registry.get(sessionId);
      if (
        record === undefined ||
        record.ownership === undefined ||
        record.ownership.runId !== lease.runId
      ) {
        throw new StaleLeaseError(sessionId, leaseId, generation);
      }
      const heartbeatAt = this.#now();
      return this.#registry.update(sessionId, record.revision, {
        updatedAt: heartbeatAt,
        ownership: { ...record.ownership, heartbeatAt },
      });
    });
  }

  /** @param {string} sessionId @param {string} leaseId @param {number} generation */
  async release(sessionId, leaseId, generation) {
    return this.#runWithOwnershipLock(sessionId, async () => {
      const lease = this.#state.leases.get(sessionId);
      if (
        lease === undefined ||
        lease.leaseId !== leaseId ||
        lease.generation !== generation
      ) {
        return false;
      }

      const record = await this.#registry.get(sessionId);
      if (record?.ownership !== undefined) {
        if (!hasLeaseOwnership(record, lease)) return false;
        const updatedAt = this.#now();
        try {
          await this.#registry.update(sessionId, record.revision, {
            ownership: undefined,
            processState: "EXITED",
            updatedAt,
          });
        } catch (error) {
          const committed = await this.#registry.get(sessionId);
          if (
            committed?.revision !== record.revision + 1 ||
            committed.ownership !== undefined ||
            committed.processState !== "EXITED"
          ) {
            throw error;
          }
        }
      }

      this.#state.leases.delete(sessionId);
      return true;
    });
  }
}
