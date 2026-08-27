/**
 * Idle exit for the daemon.
 *
 * The daemon exists to serve attached frontends and to supervise live workers. With neither, a
 * running daemon only serves stale code: it keeps whatever build it started with until someone
 * restarts it. Exiting when idle means the next command starts the current build.
 */

/**
 * @param {{ idleMs: number, now: () => number, onIdle: () => void, frontends: () => number, workers: () => number }} options
 */
export function createIdleExit({ idleMs, now, onIdle, frontends, workers }) {
  let busySince = now();
  let fired = false;
  return {
    /** Re-arm the window because the daemon has work; call this whenever a client or worker appears. */
    touch() {
      busySince = now();
    },
    /** Exit when the daemon has had no frontend and no worker for the whole idle window. */
    check() {
      if (idleMs <= 0 || fired)
        return;
      if (frontends() > 0 || workers() > 0) {
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
