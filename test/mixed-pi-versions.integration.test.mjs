import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { RecoveredWorkerRouter } from "../runtime/reconciliation.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { createWorkerControlSocket } from "../runtime/test-fixtures.mjs";
import { WorkerSupervisor } from "../runtime/worker-supervisor.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const CONNECTOR = fileURLToPath(new URL("../runtime/daemon-connector.mjs", import.meta.url));
const harness = createRealProcessHarness("mixed-pi-versions");
/** @type {any[]} */
const controlSockets = [];
afterEach(async () => {
  await Promise.all(controlSockets.splice(0).map((control) => control.close()));
  await harness.cleanup();
});

/** Launch one real worker and record it, so a timeout around this test cannot leave it running. */
async function launch(supervisor, request) {
  const handle = await supervisor.launch(request);
  await harness.record(`worker ${request.runId}`, handle.identity);
  return handle;
}

it("keeps version A live after the configured executable is atomically replaced by version B", async () => {
  const root = await harness.stateRoot("mixed-pi-", ["sessions", "runs"]);
  const sessions = join(root, "sessions");
  const runs = join(root, "runs");
  const fixture = await readFile(FIXTURE, "utf8");
  const executable = join(root, "pi-current");
  const replacement = join(root, "pi-next");
  await writeFile(executable, fixture.replace('"1.0.0"', '"0.84.1"'), { mode: 0o700 });
  await chmod(executable, 0o700);
  const registry = new RegistryStore(sessions);
  const now = "2026-08-25T12:00:00.000Z";
  for (const id of ["a", "b"]) {
    const sessionFile = join(root, `${id}.jsonl`);
    await registry.create({ schemaVersion: 1, revision: 0, sessionId: id, sessionFile, canonicalSessionFile: sessionFile, cwd: root, taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "saved_session", summary: "Saved", updatedAt: now }, createdAt: now, updatedAt: now });
  }
  const router = new RecoveredWorkerRouter({ registry, inspect: inspectProcessIdentity, metadataPath: join(root, "daemon", "workers.json") });
  await router.load();
  const control = await createWorkerControlSocket({ root, router, registry });
  controlSockets.push(control);
  const launchSeams = { daemonConnector: CONNECTOR, daemonConnectConfig: control.connectConfig };
  const supervisor = new WorkerSupervisor({ registry, router, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_EXIT_MS: "900" }, startTimeoutMs: 2_000 });
  const first = await launch(supervisor, { sessionId: "a", canonicalSessionFile: join(root, "a.jsonl"), cwd: root, runId: "run-a", ...launchSeams });
  await writeFile(replacement, fixture.replace('"1.0.0"', '"0.84.2"'), { mode: 0o700 });
  await chmod(replacement, 0o700);
  await rename(replacement, executable);
  const second = await launch(supervisor, { sessionId: "b", canonicalSessionFile: join(root, "b.jsonl"), cwd: root, runId: "run-b", ...launchSeams });

  expect(first.piChildIdentity.pid).not.toBe(second.piChildIdentity.pid);
  const firstRecord = await registry.get("a");
  const secondRecord = await registry.get("b");
  expect(firstRecord).toMatchObject({ runtime: { executable: { realpath: executable }, piVersion: "0.84.1", rpcAdapterVersion: 1 } });
  expect(secondRecord).toMatchObject({ runtime: { executable: { realpath: executable }, piVersion: "0.84.2", rpcAdapterVersion: 1 } });
  expect(firstRecord.runtime.executable).not.toEqual(secondRecord.runtime.executable);
  await supervisor.close();
});
