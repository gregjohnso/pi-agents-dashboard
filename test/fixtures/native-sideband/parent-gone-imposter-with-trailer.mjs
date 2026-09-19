// The parent-gone imposter, plus a grandchild that outlives it holding the same output pipes.
//
// Why the imposter and not the held-handoff binder. This case is about the OBSERVER's output ordering, not about
// the binder's exit branch - the exact-terminal-status case owns that. The imposter reaches its exit promptly and
// reliably on parent loss, whereas a child holding an unacknowledged handoff has been observed not to act on its
// parent's death within the deadline; when that happens the cleanup phase SIGKILLs the whole owned group, which
// takes the grandchild with it before it can write anything. Using the reliable child keeps this case's subject
// its own, and keeps the trailing output deterministic.
//
// The grandchild inherits this process's stdout and stderr, so their EOF cannot arrive until it closes them, and
// it writes its marker when this process exits. Trailing output therefore exists strictly after the parent and
// helper wait statuses are accounted for.
import { fork } from "node:child_process";
import { lstatSync, writeSync } from "node:fs";
import net from "node:net";

const BINDER_UMASK = 0o177;
const [, socketPath] = process.argv.slice(2);
if (socketPath === undefined || !socketPath.startsWith("/")) throw new Error(`imposter expected an absolute socket path, got ${socketPath}`);

const trailer = fork(new URL("./trailing-output-grandchild.mjs", import.meta.url), [], {
  execArgv: [],
  env: { PATH: "/usr/bin:/bin" },
  // Inherited on purpose: this is what keeps the observer's pipes open past this process's own exit.
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  detached: false,
});
writeSync(2, `held-handoff-binder: forked a trailing-output grandchild ${trailer.pid}\n`);

process.umask(BINDER_UMASK);
const server = net.createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, () => resolve(undefined));
});

// Byte-for-byte the diagnostics the harness waits on, so the barrier and the markers behave identically.
const entry = lstatSync(socketPath, { bigint: true });
writeSync(2, `native-sideband-binder: bound ${socketPath} as device ${entry.dev} inode ${entry.ino} mode ${(entry.mode & 0o777n).toString(8)}\n`);
writeSync(2, "held-handoff-binder: handoff written and held; the binder is bound and waiting\n");

process.once("disconnect", () => {
  writeSync(2, "native-sideband-binder: the parent went away after the bind; leaving the endpoint in place rather than unlinking a path this process can no longer prove\n");
  process.exit(0);
});
