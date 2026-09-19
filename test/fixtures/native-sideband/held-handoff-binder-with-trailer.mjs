// The held-handoff binder, plus a grandchild that outlives it holding the same output pipes.
//
// Identical to `held-handoff-binder.mjs` in everything that concerns the binder: it runs the PRODUCTION
// `runBinder` from the shipped module - real request parsing, real umask, real `net.Server`, real bind, real
// proof - with production `exit`, `onParentGone` and `diagnostic` wiring, and holds only the transport's
// completion callback so the endpoint stays bound and the handoff stays in flight.
//
// The one addition is the grandchild forked before any of that. It inherits this process's stdout and stderr, so
// their EOF cannot arrive until it closes them, and it writes its marker when this process exits. That puts
// trailing output strictly after the parent and helper wait statuses are accounted for, which is the window the
// observer's drain phase exists to cover.
import { fork } from "node:child_process";
import { writeSync } from "node:fs";

import { runBinder } from "../../../runtime/native-sideband-binder.mjs";

const trailer = fork(new URL("./trailing-output-grandchild.mjs", import.meta.url), [], {
  execArgv: [],
  env: { PATH: "/usr/bin:/bin" },
  // Inherited on purpose: this is what keeps the observer's pipes open past this process's own exit.
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  detached: false,
});
writeSync(2, `held-handoff-binder: forked a trailing-output grandchild ${trailer.pid}\n`);

runBinder({
  argv: process.argv.slice(2),
  send: (message, handle, callback) => {
    const delivered = /** @type {any} */ (process.send)(message, handle, undefined, (error) => {
      if (handle === undefined) {
        callback?.(error ?? null);
        return;
      }
      writeSync(2, "held-handoff-binder: handoff written and held; the binder is bound and waiting\n");
    });
    return delivered;
  },
  exit: (code) => process.exit(code),
  onParentGone: (handler) => {
    process.once("disconnect", handler);
    process.once("SIGHUP", handler);
  },
  diagnostic: (line) => process.stderr.write(`native-sideband-binder: ${line.slice(0, 512)}\n`),
});
