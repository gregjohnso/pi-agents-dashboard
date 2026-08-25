import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

it("keeps version A live while later launches record version B", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixed-pi-"));
  cleanup.push(root);
  const sessions = join(root, "sessions");
  const runs = join(root, "runs");
  await mkdir(sessions, { mode: 0o700 });
  await mkdir(runs, { mode: 0o700 });
  const fixture = await readFile(FIXTURE, "utf8");
  const a = join(root, "pi-a");
  const b = join(root, "pi-b");
  await writeFile(a, fixture.replace('"1.0.0"', '"A"'), { mode: 0o700 });
  await writeFile(b, fixture.replace('"1.0.0"', '"B"'), { mode: 0o700 });
  await chmod(a, 0o700);
  await chmod(b, 0o700);
  const registry = new RegistryStore(sessions);
  const now = "2026-08-25T12:00:00.000Z";
  for (const id of ["a", "b"]) {
    const sessionFile = join(root, `${id}.jsonl`);
    await registry.create({ schemaVersion: 1, revision: 0, sessionId: id, sessionFile, canonicalSessionFile: sessionFile, cwd: root, taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "saved_session", summary: "Saved", updatedAt: now }, createdAt: now, updatedAt: now });
  }
  const supervisor = new WorkerSupervisor({ registry, runsDirectory: runs, env: { ...process.env, FAKE_PI_EXIT_MS: "900" }, startTimeoutMs: 2_000 });
  const first = await supervisor.launch({ sessionId: "a", canonicalSessionFile: join(root, "a.jsonl"), cwd: root, runId: "run-a", piPath: a });
  const second = await supervisor.launch({ sessionId: "b", canonicalSessionFile: join(root, "b.jsonl"), cwd: root, runId: "run-b", piPath: b });

  expect(first.piChildIdentity.pid).not.toBe(second.piChildIdentity.pid);
  expect(await registry.get("a")).toMatchObject({ runtime: { executable: { realpath: a }, piVersion: "A" } });
  expect(await registry.get("b")).toMatchObject({ runtime: { executable: { realpath: b }, piVersion: "B" } });
  await supervisor.close();
});
