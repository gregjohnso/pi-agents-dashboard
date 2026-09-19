// A real child process that runs the PRODUCTION binder and holds its handoff, so parent loss can be observed
// while the endpoint is genuinely bound and the handoff genuinely in flight.
//
// Why this exists. The red run measured what the shipped entrypoint does on its own: it binds, writes its
// handoff and leaves within a few milliseconds, so a parent that dies "after the bind" almost always loses the
// race and finds the helper already gone with exit 0. That is honest behaviour, but it proves nothing about
// `onParentGone`, which is precisely the branch the review requires evidence for.
//
// What is production here, and what is held. `runBinder` is imported from the shipped module and is the
// implementation under test: it reads the request, sets the real restrictive umask, creates a real `net.Server`,
// binds the real endpoint and reads the real proof. `exit`, `onParentGone` and `diagnostic` are wired exactly as
// the shipped entrypoint wires them - `process.exit`, `process.once("disconnect")`, `process.once("SIGHUP")`,
// stderr. The single thing this fixture controls is the *timing of the transport*: the handoff message that
// carries the listener is written to the channel and its completion callback is never invoked, so the binder
// stays exactly where a slow acknowledgement would leave it. Nothing about its decisions is replaced.
import { writeSync } from "node:fs";

import { runBinder } from "../../../runtime/native-sideband-binder.mjs";

runBinder({
  argv: process.argv.slice(2),
  send: (message, handle, callback) => {
    const delivered = /** @type {any} */ (process.send)(message, handle, undefined, (error) => {
      if (handle === undefined) {
        // Refusals and bind failures are not what this fixture holds; they complete normally.
        callback?.(error ?? null);
        return;
      }
      // The handoff is held here, and only here: the callback the binder is waiting on is never invoked, so it
      // neither reports success nor gives up. The listener stays bound and this process stays alive.
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
