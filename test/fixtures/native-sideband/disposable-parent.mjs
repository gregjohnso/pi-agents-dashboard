// A disposable real parent for the socket binder, so parent loss can be tested as a process event.
//
// The point of this file is that the parent is real: a separate, killable process that owns a real IPC channel
// to a real child. An in-process callback with a stubbed `exit` cannot show that a helper terminated or that its
// bound listener was released; this can.
//
// Usage: `node disposable-parent.mjs <mode> <childScript> <socketPath>`, where mode is
//   `disconnect` - on release, close the IPC channel, then report the child's own terminal outcome, which this
//                  process is entitled to observe because it is the parent.
//   `hold`       - stay alive and do nothing. The harness kills this process instead.
//
// The child's stdout and stderr are inherited, so its diagnostics reach the harness directly rather than through
// this process. That is also what makes the shared stderr pipe report EOF only once both this process and the
// child are gone, which is the harness's proof of child termination in the case where this process is killed
// outright and can report nothing itself.
//
// Markers are written with `writeSync` so ordering against the child's own output is never in question.
import { fork } from "node:child_process";
import { writeSync } from "node:fs";

const SIDEBAND_BINDER_PROTOCOL = 2;

const [mode, childScript, socketPath] = process.argv.slice(2);
if (mode !== "disconnect" && mode !== "hold") throw new Error(`disposable parent expected mode disconnect or hold, got ${mode}`);
if (childScript === undefined) throw new Error("disposable parent expected a child script path");
if (socketPath === undefined || !socketPath.startsWith("/")) throw new Error(`disposable parent expected an absolute socket path, got ${socketPath}`);

const child = fork(childScript, [String(SIDEBAND_BINDER_PROTOCOL), socketPath], {
  execArgv: [],
  env: { PATH: "/usr/bin:/bin" },
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  detached: false,
});

writeSync(1, `disposable-parent-pid ${process.pid}\nbinder-pid ${child.pid}\n`);

// Deliberately never reads the IPC channel's messages for anything: this parent's only job is to exist, and then
// to stop existing. The channel keeps its event loop alive, so nothing here spins or polls.
if (mode === "disconnect") {
  process.stdin.once("data", () => {
    child.disconnect();
    child.once("exit", (code, signal) => {
      writeSync(1, `binder-exit ${code} ${signal}\n`);
      process.exit(0);
    });
  });
} else {
  child.once("exit", (code, signal) => {
    writeSync(1, `binder-exit-unexpected ${code} ${signal}\n`);
    process.exit(0);
  });
}
