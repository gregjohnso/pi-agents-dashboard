import { lstat, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const WORKER_PATH = fileURLToPath(new URL("../runtime/worker.mjs", import.meta.url));
const harness = createRealProcessHarness("worker socket");

/** @template T @param {() => Promise<T>} read */
async function waitFor(read) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

afterEach(async () => {
  await harness.cleanup();
});

// Operator-visible failure: a daemon that dies right after spawning a worker leaves that worker
// listening on a socket nothing will ever connect to. It holds no Pi child and none of the
// operator's text, so a process that waits forever is pure cost, and the bound is what stops it.
it("exits when no daemon connects to its socket before the startup deadline the daemon passed it", async () => {
  const root = await harness.stateRoot("dashboard-worker-socket-", ["daemon/workers", "runs/abandoned/diagnostics"]);
  const socketPath = join(root, "daemon", "workers", "never-connected.sock");
  const piPath = join(root, "pi-that-never-runs.mjs");
  await writeFile(piPath, "process.exit(0)\n", { mode: 0o700 });
  const child = spawn(process.execPath, [
    WORKER_PATH,
    "--session-id", "one",
    "--canonical-session-file", join(root, "one.jsonl"),
    "--cwd", root,
    "--run-id", "run-abandoned",
    "--lease-id", "lease-abandoned",
    "--generation", "1",
    "--replay-path", join(root, "runs", "abandoned", "worker-replay.jsonl"),
    "--pi-executable", piPath,
    "--pi-identity", JSON.stringify({ realpath: piPath, device: "injected", inode: "injected", size: 0, modifiedTimeNs: "0" }),
    "--capabilities", JSON.stringify({ reportedVersion: "injected", rpcMode: true, jsonl: true, commands: [], events: [], missingRequired: [] }),
    "--diagnostics-directory", join(root, "runs", "abandoned", "diagnostics"),
    "--worker-socket", socketPath,
    // Long enough that a loaded machine cannot expire it before the worker has listened: this file
    // shares a parallel run with tests that spawn real daemons, and 500 ms lost that race.
    "--startup-deadline-ms", "2000",
  ], { cwd: root, detached: true, shell: false, env: { ...process.env, PI_AGENTS_WORKER_TOKEN: "abandoned-token" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  try {
    await harness.record("abandoned worker", await inspectProcessIdentity(/** @type {number} */ (child.pid)));
    // It listened first: the socket exists because the worker created it, never because the daemon did.
    const listening = await waitFor(() => lstat(socketPath));
    expect(listening.isSocket()).toBe(true);
    expect(listening.mode & 0o777).toBe(0o600);

    const exit = await new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
    expect(exit).not.toMatchObject({ code: 0 });
    expect(stderr).toContain("WORKER_STARTUP_DEADLINE");
    // The path goes with the worker, so nothing is left for a later daemon to connect to.
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    try { process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL"); } catch {}
  }
});

it("refuses to start at all when the daemon named no socket for it to listen on", async () => {
  const root = await harness.stateRoot("dashboard-worker-socket-", ["runs/nameless/diagnostics"]);
  const piPath = join(root, "pi-that-never-runs.mjs");
  await writeFile(piPath, "process.exit(0)\n", { mode: 0o700 });
  const child = spawn(process.execPath, [
    WORKER_PATH,
    "--session-id", "one",
    "--canonical-session-file", join(root, "one.jsonl"),
    "--cwd", root,
    "--run-id", "run-nameless",
    "--lease-id", "lease-nameless",
    "--generation", "1",
    "--replay-path", join(root, "runs", "nameless", "worker-replay.jsonl"),
    "--pi-executable", piPath,
    "--pi-identity", JSON.stringify({ realpath: piPath, device: "injected", inode: "injected", size: 0, modifiedTimeNs: "0" }),
    "--capabilities", JSON.stringify({ reportedVersion: "injected", rpcMode: true, jsonl: true, commands: [], events: [], missingRequired: [] }),
    "--diagnostics-directory", join(root, "runs", "nameless", "diagnostics"),
  ], { cwd: root, detached: true, shell: false, env: { ...process.env, PI_AGENTS_WORKER_TOKEN: "nameless-token" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  try {
    await harness.record("nameless worker", await inspectProcessIdentity(/** @type {number} */ (child.pid)));
    const exit = await new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
    expect(exit).not.toMatchObject({ code: 0 });
    expect(stderr).toContain("--worker-socket");
  } finally {
    try { process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL"); } catch {}
  }
});
