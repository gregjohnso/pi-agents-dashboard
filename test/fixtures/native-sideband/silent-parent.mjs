// A disposable parent that forks its child and never announces it.
//
// The observer learns the helper's pid only by parsing `binder-pid <n>` out of the relayed stream, so this
// fixture creates exactly the case that parsing cannot cover: an owned descendant whose identity was never
// reported. A cleanup phase that signals only the pids it happens to know leaves this one running; one that owns
// the whole subtree does not.
//
// Everything else matches `disposable-parent.mjs`: a real fork, a real IPC channel, the child's stdout and
// stderr inherited so its own diagnostics still reach the observer.
//
// Usage: `node silent-parent.mjs <mode> <childScript> <socketPath>` - mode is accepted and ignored, so this is
// substitutable for the announcing parent wherever a test wants the silent variant.
import { fork } from "node:child_process";
import { writeSync } from "node:fs";

const SIDEBAND_BINDER_PROTOCOL = 2;

const [, childScript, socketPath] = process.argv.slice(2);
if (childScript === undefined) throw new Error("silent parent expected a child script path");
if (socketPath === undefined || !socketPath.startsWith("/")) throw new Error(`silent parent expected an absolute socket path, got ${socketPath}`);

const child = fork(childScript, [String(SIDEBAND_BINDER_PROTOCOL), socketPath], {
  execArgv: [],
  env: { PATH: "/usr/bin:/bin" },
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  detached: false,
});

// Its own pid, so the harness can still tell this fixture started. Deliberately NOT the child's.
writeSync(1, `silent-parent-pid ${process.pid}\nsilent-parent-withheld-child-identity yes\n`);
if (child.pid === undefined) throw new Error("silent parent could not fork its child");

// Nothing else. No kill handler and no exit path: this parent waits to be cleaned up, which is the scenario.
