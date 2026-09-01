/**
 * Idle exit for the daemon.
 *
 * The daemon runs on demand. It exists to serve dashboards and to finish the work one asked for;
 * with neither, a running daemon only serves stale code, keeping whatever build it started with
 * until someone restarts it. Exiting when idle means the next command starts the current build.
 *
 * Idle is not "no connected clients". A worker holds a connection too, and a command, a launch or a
 * worker replacement outlives the dashboard that started it. What may exit is a daemon with no
 * dashboard and nothing of its own left to finish; live workers are deliberately not part of that,
 * because a worker is Pi's parent, survives daemon absence indefinitely, and keeps recording.
 */

/**
 * How long the daemon stays up with nothing to do. Long enough to absorb a probe followed by the
 * connection it precedes, and a dashboard closed and reopened straight away, both of which would
 * otherwise pay a cold start. Short enough that a closed dashboard leaves no resident process.
 */
export const DEFAULT_IDLE_EXIT_MS = 30_000;

/**
 * Select the idle window from `--idle-exit-ms`, then `PI_AGENTS_IDLE_EXIT_MS`, then the default.
 * Zero means a resident daemon, which now has to be asked for. A value that cannot be read throws
 * rather than defaulting, because silently staying resident is the state this exists to end.
 *
 * @param {{ argv?: readonly string[], env?: NodeJS.ProcessEnv }} options
 */
export function resolveIdleExitMs({ argv = [], env = {} }) {
  const flag = argv.indexOf("--idle-exit-ms");
  const selected = flag >= 0 ? argv[flag + 1] : env.PI_AGENTS_IDLE_EXIT_MS;
  if (selected === undefined) return DEFAULT_IDLE_EXIT_MS;
  const idleMs = Number(selected);
  if (!Number.isFinite(idleMs) || idleMs < 0) throw new TypeError(`Idle exit window must be a non-negative number of milliseconds, not ${JSON.stringify(selected)}`);
  return idleMs;
}

/**
 * @param {{ idleMs: number, now: () => number, onIdle: () => void, hold: () => string | undefined }} options
 * `hold` names why the daemon must stay up, or returns undefined when nothing holds it.
 */
export function createIdleExit({ idleMs, now, onIdle, hold }) {
  let busySince = now();
  let fired = false;
  return {
    /** Re-arm the window for activity a check cannot see, such as a connection that opened and closed between two. */
    touch() {
      busySince = now();
    },
    /** Exit when nothing has held the daemon for the whole idle window. */
    check() {
      if (idleMs <= 0 || fired)
        return;
      if (hold() !== undefined) {
        busySince = now();
        return;
      }
      if (now() - busySince < idleMs)
        return;
      fired = true;
      onIdle();
    },
  };
}
