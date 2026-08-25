/**
 * Create an inspector whose results can model exit and PID reuse deterministically.
 *
 * @param {unknown[]} sequence
 */
export function createSequenceInspector(sequence) {
  const remaining = [...sequence];
  /** @type {number[]} */
  const calls = [];
  return {
    calls,
    /** @param {number} pid */
    async inspect(pid) {
      calls.push(pid);
      if (remaining.length === 0) {
        throw new Error("Inspector sequence exhausted");
      }
      const next = remaining.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

/**
 * Record graceful requests and process-group signals without signaling real processes.
 *
 * @param {Set<number>} [aliveGroups]
 */
export function createFakeSignaler(aliveGroups = new Set()) {
  /** @type {Array<{ type: string, ownership?: unknown, pgid?: number, signal?: NodeJS.Signals }>} */
  const calls = [];
  return {
    calls,
    /** @param {unknown} ownership */
    async requestGraceful(ownership) {
      calls.push({ type: "graceful", ownership });
    },
    /** @param {number} pgid @param {NodeJS.Signals} signal */
    signalProcessGroup(pgid, signal) {
      calls.push({ type: "signal", pgid, signal });
      if (signal === "SIGKILL") {
        aliveGroups.delete(pgid);
      }
    },
  };
}

/**
 * Return a sleep seam that records configured delays and runs optional boundary hooks.
 *
 * @param {Array<(() => unknown | Promise<unknown>) | undefined>} [hooks]
 */
export function createFakeSleep(hooks = []) {
  /** @type {number[]} */
  const calls = [];
  return {
    calls,
    /** @param {number} ms */
    async sleep(ms) {
      calls.push(ms);
      const hook = hooks.shift();
      if (hook) {
        await hook();
      }
    },
  };
}
