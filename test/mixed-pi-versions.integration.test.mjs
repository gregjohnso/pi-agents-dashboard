import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { RegistryStore } from "../runtime/registry-store.mjs";
import { WorkerSupervisor } from "../runtime/worker-supervisor.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
/** @type {string[]} */
const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

it("keeps version A live after the configured executable is atomically replaced by version B", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixed-pi-"));
  cleanup.push(root);
  const sessions = join(root, "sessions");
  const runs = join(root, "runs");
  await mkdir(sessions, { mode: 0o700 });
  await mkdir(runs, { mode: 0o700 });
  const fixture = await readFile(FIXTURE, "utf8");
  const executable = join(root, "pi-current");
  const replacement = join(root, "pi-next");
  await writeFile(executable, fixture.replace('"1.0.0"', '"A"'), { mode: 0o700 });
  await chmod(executable, 0o700);
  const registry = new RegistryStore(sessions);
  const now = "2026-08-25T12:00:00.000Z";
  for (const id of ["a", "b"]) {
    const sessionFile = join(root, `${id}.jsonl`);
    await registry.create({ schemaVersion: 1, revision: 0, sessionId: id, sessionFile, canonicalSessionFile: sessionFile, cwd: root, taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "saved_session", summary: "Saved", updatedAt: now }, createdAt: now, updatedAt: now });
  }
  const supervisor = new WorkerSupervisor({ registry, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_EXIT_MS: "900" }, startTimeoutMs: 2_000 });
  const first = await supervisor.launch({ sessionId: "a", canonicalSessionFile: join(root, "a.jsonl"), cwd: root, runId: "run-a" });
  await writeFile(replacement, fixture.replace('"1.0.0"', '"B"'), { mode: 0o700 });
  await chmod(replacement, 0o700);
  await rename(replacement, executable);
  const second = await supervisor.launch({ sessionId: "b", canonicalSessionFile: join(root, "b.jsonl"), cwd: root, runId: "run-b" });

  expect(first.piChildIdentity.pid).not.toBe(second.piChildIdentity.pid);
  const firstRecord = await registry.get("a");
  const secondRecord = await registry.get("b");
  expect(firstRecord).toMatchObject({ runtime: { executable: { realpath: executable }, piVersion: "A", rpcAdapterVersion: 1 } });
  expect(secondRecord).toMatchObject({ runtime: { executable: { realpath: executable }, piVersion: "B", rpcAdapterVersion: 1 } });
  expect(firstRecord.runtime.executable).not.toEqual(secondRecord.runtime.executable);
  await supervisor.close();
});
