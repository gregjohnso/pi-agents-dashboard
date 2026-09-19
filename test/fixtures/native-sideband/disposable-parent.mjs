// A disposable real parent for the socket binder, so parent loss can be tested as a process event.
//
// The point of this file is that nothing about the binder is faked: it forks the **production**
// `runtime/native-sideband-binder.mjs` over a real IPC channel and is a real, separate, killable parent
// process. An in-process callback with a stubbed `exit` cannot show that a helper terminated or that its bound
// listener was released; this can.
//
// The barrier that makes both scenarios deterministic is a blocking read of this process's own stdin. A handle
// send is not complete until the receiving side acknowledges it, and that acknowledgement needs this event
// loop. While this process is blocked in `readSync`, the binder has bound its endpoint and its handoff is in
// flight and cannot finish - which is exactly the window the scenarios need. No sleep and no polling: the read
// returns when the harness writes a byte, and never otherwise.
//
// Usage: `node disposable-parent.mjs <mode> <socketPath>`, where mode is
//   `disconnect` - on release, close the IPC channel before any message is handled, then report the binder's
//                  own terminal outcome, which this process is entitled to observe because it is the parent.
//   `hold`       - stay blocked. The harness kills this process while the handoff is in flight.
//
// Markers are written with `writeSync` so the harness has them before this process stops turning its loop.
import { fork } from "node:child_process";
import { readSync, writeSync } from "node:fs";

const BINDER = new URL("../../../runtime/native-sideband-binder.mjs", import.meta.url);
const SIDEBAND_BINDER_PROTOCOL = 2;

const [mode, socketPath] = process.argv.slice(2);
if (mode !== "disconnect" && mode !== "hold") throw new Error(`disposable parent expected mode disconnect or hold, got ${mode}`);
if (socketPath === undefined || !socketPath.startsWith("/")) throw new Error(`disposable parent expected an absolute socket path, got ${socketPath}`);

// The binder's stdout and stderr are inherited, so its own diagnostics reach the harness directly rather than
// through this process's event loop. That is what lets the harness see `bound ...` while this process is blocked,
// and it is also what makes the shared stderr pipe report EOF only once both this process and the binder are
// gone - the harness's proof of helper termination when this process is killed and cannot report anything.
const binder = fork(BINDER, [String(SIDEBAND_BINDER_PROTOCOL), socketPath], {
  execArgv: [],
  env: { PATH: "/usr/bin:/bin" },
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  detached: false,
});

writeSync(1, `disposable-parent-pid ${process.pid}\nbinder-pid ${binder.pid}\n`);

// Blocks this event loop, so the handoff cannot be acknowledged. One byte from the harness releases it.
readSync(0, Buffer.alloc(1), 0, 1, null);

if (mode === "disconnect") {
  // Synchronous, and before the loop turns again, so no queued handoff message is handled first: the binder
  // observes a parent that closed the channel while its handoff was still in flight.
  binder.disconnect();
  binder.once("exit", (code, signal) => {
    writeSync(1, `binder-exit ${code} ${signal}\n`);
    process.exit(0);
  });
} else {
  writeSync(1, "released-without-being-killed\n");
  process.exit(0);
}
