import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDaemonCommand, spawnDaemon } from "../cli/daemon-commands.mjs";
import { identifyDaemonChild } from "../runtime/daemon-lifecycle.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { openProcessLedger, reapProcessLedger, recordProcess, reportReapResults } from "./process-ledger.mjs";

/**
 * One lifecycle for the suites that start real daemons, workers and Pi children.
 *
 * Every suite here used to carry its own copy: an array of roots, an array of started roots, an
 * `afterEach` that stopped each one and removed the directory, and in two cases a `ps` scan or a
 * bare `process.kill`. All of it ran only when the test's own teardown ran, which is not the case
 * that leaks. This puts the record on disk instead, keyed to the run rather than to the test.
 *
 * `cleanup` runs three steps in order and none of them may be swapped. The daemon is stopped
 * through the product's own `daemon stop`, which is the path an operator takes and the only one
 * that proves exit. Whatever that missed is then reaped by verified identity from the ledger. Only
 * then are the directories removed, because a daemon whose publication is gone can no longer be
 * stopped by identity at all.
 */

/** Commands that can leave a daemon running at the root they were given. */
const STARTING_COMMANDS = ["start", "restart", "recover"];

/** @param {string} label a name for this suite, used in ledger entries and in the temporary root prefix */
export function createRealProcessHarness(label) {
  /** @type {string[]} */
  const directories = [];
  /** @type {{ root: string, stopOptions: any }[]} */
  const daemonRoots = [];
  /** @type {Promise<unknown>[]} */
  const recordings = [];
  /** @type {string | undefined} */
  let ledgerPath;

  const ledger = async () => {
    ledgerPath ??= await openProcessLedger({ label });
    return ledgerPath;
  };

  /** @param {string} path @param {{ pid?: number }} child */
  const recordChild = async (path, child) => {
    const spawned = await identifyDaemonChild(child, inspectProcessIdentity);
    // A child that exited before its identity could be read left nothing to reap; one whose group
    // is led by something else is not this child, and signalling it is exactly what is forbidden.
    if (spawned.status !== "IDENTIFIED") return;
    await recordProcess(path, `${label} daemon child`, spawned.identity);
  };

  return {
    /** The ledger this harness writes to, opened on first use. */
    ledgerPath() {
      if (ledgerPath === undefined) throw new Error("This harness has recorded nothing yet, so it has no ledger");
      return ledgerPath;
    },

    /**
     * Build a throwaway state root and register it for removal.
     * @param {string} prefix @param {string[]} [subdirectories]
     */
    async stateRoot(prefix, subdirectories = []) {
      const root = await mkdtemp(join(tmpdir(), prefix));
      directories.push(root);
      for (const directory of subdirectories) await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
      return root;
    },

    /**
     * Register a root a daemon was started at by something other than `daemon` below.
     * @param {string} root @param {any} [stopOptions]
     */
    daemonRoot(root, stopOptions = {}) {
      if (!daemonRoots.some((entry) => entry.root === root)) daemonRoots.push({ root, stopOptions });
      return root;
    },

    /**
     * Record one process this suite started outside `daemon` below, such as a launched worker.
     *
     * @param {string} processLabel @param {{ pid: number, startIdentity: string, processGroupId: number }} identity
     */
    async record(processLabel, identity) {
      await recordProcess(await ledger(), `${label} ${processLabel}`, identity);
      return identity;
    },

    /**
     * Run one daemon command, recording any child it spawns before that command can time out.
     *
     * The record is appended from inside the spawn seam, so it lands while the start is still
     * waiting for a healthy endpoint. That wait is where the leak happened: the command gave up,
     * and the child it abandoned published itself seconds later with nobody left to notice.
     *
     * @param {"start" | "restart" | "recover" | "stop" | "status"} command @param {any} [options]
     */
    async daemon(command, options = {}) {
      const path = await ledger();
      const result = await runDaemonCommand(command, {
        ...options,
        spawnDaemon: (/** @type {string} */ file, /** @type {string[]} */ argv, /** @type {NodeJS.ProcessEnv} */ env, /** @type {number | "ignore"} */ stderr) => {
          const child = spawnDaemon(file, argv, env, stderr);
          recordings.push(recordChild(path, child));
          return child;
        },
      });
      await Promise.all(recordings.splice(0));
      const root = result.result?.root ?? options.root;
      if (STARTING_COMMANDS.includes(command) && typeof root === "string") this.daemonRoot(root, { env: options.env });
      return result;
    },

    /** Stop, reap, then remove. Safe to call twice: a suite's `afterEach` and a test may both call it. */
    async cleanup() {
      await Promise.allSettled(recordings.splice(0));
      for (const { root, stopOptions } of daemonRoots.splice(0).reverse()) {
        await runDaemonCommand("stop", { root, allowLiveWorkers: true, ...stopOptions }).catch(() => {});
      }
      if (ledgerPath !== undefined) {
        reportReapResults(await reapProcessLedger(ledgerPath), console.error);
        await rm(ledgerPath, { force: true });
        ledgerPath = undefined;
      }
      await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    },
  };
}
