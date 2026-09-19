// A helper that produces every piece of the OLD evidence set and still dies with a different terminal status.
//
// This exists to make one claim falsifiable. The abrupt-parent-death case used to rest on two observations - the
// helper printed `the parent went away after the bind; leaving the endpoint in place`, and its pid was afterwards
// unused - and from those it was concluded that the production `process.exit(4)` branch had run. This fixture
// satisfies both observations exactly, emitting the identical markers and the identical diagnostic, and then
// exits **0**. Anything that cannot tell it apart from the real helper was never measuring terminal status.
//
// It is an imposter and nothing else: it is never used to qualify the production binder, only to demonstrate what
// the diagnostic-plus-disappearance evidence set cannot distinguish.
import { lstatSync, writeSync } from "node:fs";
import net from "node:net";

const BINDER_UMASK = 0o177;
const [, socketPath] = process.argv.slice(2);
if (socketPath === undefined || !socketPath.startsWith("/")) throw new Error(`imposter expected an absolute socket path, got ${socketPath}`);

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
  // The same sentence the production helper writes on this branch, and then the wrong status.
  writeSync(2, "native-sideband-binder: the parent went away after the bind; leaving the endpoint in place rather than unlinking a path this process can no longer prove\n");
  process.exit(0);
});
