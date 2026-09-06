import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

/**
 * Operator-visible failure, 2026-09-06: `daemon restart` reported `daemon_started` while the daemon
 * from the previous day kept serving. Every launch against it spent the worker's whole 15,000 ms
 * startup deadline and died with `WORKER_STARTUP_DEADLINE`, and the release on disk never ran.
 * Nothing covered a restart followed by a launch, so nothing failed.
 */

const fakePiSource = await readFile(fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url)), "utf8");
const harness = createRealProcessHarness("daemon-restart-acceptance");

afterEach(async () => { await harness.cleanup(); });

function request(requestId, op, payload) {
  return { version: 1, clientId: "restart-acceptance", requestId, op, payload };
}

it("serves a launch on the daemon a restart installed", async () => {
  const root = await harness.stateRoot("pi-agents-restart-", ["canonical", "daemon", "sessions", "runs", "index"]);
  const executable = join(root, "pi");
  await writeFile(executable, fakePiSource.replace('process.env.FAKE_PI_VERSION ?? "1.0.0"', JSON.stringify("0.84.0")), { mode: 0o700 });
  await chmod(executable, 0o700);
  const env = { ...process.env, FAKE_PI_LOG: join(root, "fake-pi.jsonl") };
  let client;
  try {
    const started = await harness.daemon("start", { root, piBin: executable, env, timeoutMs: 20_000 });
    expect(started).toMatchObject({ code: 0, result: { kind: "daemon_started", alreadyRunning: false } });

    const restarted = await harness.daemon("restart", { root, piBin: executable, env, timeoutMs: 20_000 });
    // A restart that leaves the old daemon serving is the failure: the identity has to change, and
    // the result has to name what it replaced.
    expect(restarted).toMatchObject({ code: 0, result: { kind: "daemon_started", alreadyRunning: false } });
    expect(restarted.result.publication.pid).not.toBe(started.result.publication.pid);
    expect(restarted.result.replacedPublication).toMatchObject({ pid: started.result.publication.pid });
    expect(JSON.parse(await readFile(join(root, "daemon", "pid.json"), "utf8")).pid).toBe(restarted.result.publication.pid);

    client = createDaemonClient({
      socketPath: join(root, "daemon", "control.sock"),
      token: (await readFile(join(root, "daemon", "control.token"), "utf8")).trim(),
      clientId: "restart-acceptance", reconnect: false, maxBytes: 256 * 1024,
    });
    await client.connect();
    const launched = await client.request(request("launch-after-restart", "launch", {
      prompt: "after restart",
      cwd: root,
      sourceSessionId: "dashboard-restart-acceptance",
      isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: [] },
    }));
    if (!launched.ok) throw new Error(`Launch after restart failed: ${JSON.stringify(launched)}`);

    const records = await new RegistryStore(join(root, "sessions")).list();
    if (records[0]?.ownership?.process !== undefined) await harness.record("launched worker", records[0].ownership.process);
    expect(records).toEqual([expect.objectContaining({ sessionId: launched.result.sessionId, processState: "LIVE" })]);
  } finally {
    await client?.close();
    const stopped = await harness.daemon("stop", { root, allowLiveWorkers: true, env });
    if (![0, 3].includes(stopped.code)) throw new Error(`Restart acceptance cleanup failed: ${JSON.stringify(stopped)}`);
  }
});
