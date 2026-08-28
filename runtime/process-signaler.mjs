/**
 * Send one signal to exactly the positive process-group ID supplied by verified ownership.
 *
 * @param {number} pgid
 * @param {NodeJS.Signals} signal
 */
export function signalProcessGroup(pgid, signal) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new TypeError("Process-group ID must be a positive safe integer");
  }
  process.kill(-pgid, signal);
}

/** How often a stop window is rechecked, so a process that exits early does not cost the whole window. */
export const EXIT_POLL_INTERVAL_MS = 25;

/** @param {number} ms */
export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {unknown} value @param {string} name */
function positiveMilliseconds(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return /** @type {number} */ (value);
}

/** @param {any} identity */
function validIdentity(identity) {
  return (
    identity !== null &&
    typeof identity === "object" &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    Number.isSafeInteger(identity.processGroupId) &&
    identity.processGroupId > 0 &&
    typeof identity.startIdentity === "string" &&
    /^\d+$/u.test(identity.startIdentity) &&
    BigInt(identity.startIdentity) > 0n
  );
}

/** @param {any} actual @param {any} expected */
function sameIdentity(actual, expected) {
  return (
    validIdentity(actual) &&
    actual.pid === expected.pid &&
    actual.processGroupId === expected.processGroupId &&
    actual.startIdentity === expected.startIdentity
  );
}

/**
 * Gracefully stop and escalate signals only while PID/start-time/PGID ownership stays exact.
 *
 * Each stop window is polled rather than slept through, so escalation follows the observed exit;
 * a process that keeps matching still gets the whole window before the next signal.
 * The timing policy is the validated `config.stop` object from shared/config.ts.
 *
 * @param {{ pid: number, processGroupId: number, startIdentity: string }} ownership
 * @param {{ inspect(pid: number): Promise<unknown>, requestGraceful(ownership: { pid: number, processGroupId: number, startIdentity: string }): Promise<void>, signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void | Promise<void>, sleep(ms: number): Promise<void>, now?: () => number, abortSignal?: AbortSignal }} deps
 * @param {{ gracefulMs: number, terminateMs: number }} [policy]
 */
export async function stopVerifiedProcessGroup(ownership, deps, policy) {
  if (!validIdentity(ownership)) {
    throw new TypeError("Ownership must contain a valid PID, process-group ID, and start time");
  }
  if (policy === undefined || policy === null || typeof policy !== "object") {
    throw new TypeError("A reviewed stop timing policy is required");
  }
  const gracefulMs = positiveMilliseconds(policy.gracefulMs, "gracefulMs");
  const terminateMs = positiveMilliseconds(policy.terminateMs, "terminateMs");
  if (
    typeof deps?.inspect !== "function" ||
    typeof deps.requestGraceful !== "function" ||
    typeof deps.signalProcessGroup !== "function" ||
    typeof deps.sleep !== "function"
  ) {
    throw new TypeError("Process signaling dependencies are incomplete");
  }

  const cancelled = () => deps.abortSignal?.aborted === true;
  const inspect = async () => {
    if (cancelled()) {
      return "CANCELLED";
    }
    try {
      const current = await deps.inspect(ownership.pid);
      return sameIdentity(current, ownership) ? "MATCH" : "STALE_IDENTITY";
    } catch (error) {
      if (
        error instanceof Error &&
        ["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")
      ) {
        return "EXITED";
      }
      return "AMBIGUOUS_IDENTITY";
    }
  };

  // The window is a deadline, not a sum of sleeps: polling cost must not push the next signal past it.
  const clock = typeof deps.now === "function" ? deps.now : Date.now;
  /** @param {number} windowMs */
  const awaitBoundary = async (windowMs) => {
    const deadline = clock() + windowMs;
    let observed = "MATCH";
    for (;;) {
      const remaining = deadline - clock();
      if (observed !== "MATCH" || remaining <= 0) return observed;
      await deps.sleep(Math.min(EXIT_POLL_INTERVAL_MS, remaining));
      observed = await inspect();
    }
  };

  const initial = await inspect();
  if (initial !== "MATCH") {
    return { disposition: initial === "EXITED" ? "ALREADY_EXITED" : initial };
  }

  const gracefulBoundary = await inspect();
  if (gracefulBoundary !== "MATCH") {
    return {
      disposition: gracefulBoundary === "EXITED" ? "ALREADY_EXITED" : gracefulBoundary,
    };
  }
  if (cancelled()) {
    return { disposition: "CANCELLED" };
  }
  await deps.requestGraceful(ownership);

  const terminateBoundary = await awaitBoundary(gracefulMs);
  if (terminateBoundary !== "MATCH") {
    return {
      disposition: terminateBoundary === "EXITED" ? "GRACEFUL" : terminateBoundary,
    };
  }
  if (cancelled()) {
    return { disposition: "CANCELLED" };
  }
  await deps.signalProcessGroup(ownership.processGroupId, "SIGTERM");

  const killBoundary = await awaitBoundary(terminateMs);
  if (killBoundary !== "MATCH") {
    return killBoundary === "EXITED"
      ? { disposition: "TERMINATED" }
      : { disposition: killBoundary, signaled: true };
  }
  if (cancelled()) {
    return { disposition: "CANCELLED", signaled: true };
  }
  try {
    await deps.signalProcessGroup(ownership.processGroupId, "SIGKILL");
  } catch (error) {
    if (error instanceof Error && ["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) {
      return { disposition: "KILLED" };
    }
    throw error;
  }
  const observed = await inspect();
  if (observed === "EXITED") return { disposition: "KILLED" };
  if (observed === "MATCH") return { disposition: "KILL_REQUESTED" };
  return { disposition: observed, signaled: true };
}
