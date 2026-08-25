import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

import {
  claimDaemonLifecycle,
  inspectDaemonEndpoint,
  releaseDaemonLifecycle,
} from "./daemon-lifecycle.mjs";

/** @type {string[]} */
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dashboard-daemon-lifecycle-"));
  roots.push(root);
  await mkdir(join(root, "daemon"), { mode: 0o700 });
  return root;
}

it("serializes concurrent starts and publishes one exact daemon identity", async () => {
  const root = await fixture();
  const identity = { pid: 41, startIdentity: "100", processGroupId: 41 };
  const inspect = async () => identity;
  const first = await claimDaemonLifecycle({ root, identity, daemonEpoch: "epoch", tokenPath: join(root, "daemon", "control.token"), inspect });
  await expect(claimDaemonLifecycle({ root, identity, daemonEpoch: "other", tokenPath: join(root, "daemon", "control.token"), inspect })).rejects.toMatchObject({ code: "DAEMON_ALREADY_RUNNING" });
  expect((await inspectDaemonEndpoint({ root, inspect, probe: async () => true })).status).toBe("HEALTHY");
  await releaseDaemonLifecycle(first);
});

it("removes a stale socket only after exact PID/start identity mismatch", async () => {
  const root = await fixture();
  const identity = { pid: 51, startIdentity: "old", processGroupId: 51 };
  const claim = await claimDaemonLifecycle({ root, identity, daemonEpoch: "epoch", tokenPath: join(root, "daemon", "control.token"), inspect: async () => identity });
  await releaseDaemonLifecycle(claim, { preservePublication: true });

  const stale = await inspectDaemonEndpoint({
    root,
    inspect: async () => ({ pid: 51, startIdentity: "reused", processGroupId: 51 }),
    probe: async () => false,
  });
  expect(stale.status).toBe("STALE");
  expect(stale.canCleanup).toBe(true);
});

it("reports a live but unreachable daemon unhealthy without authorizing unlink", async () => {
  const root = await fixture();
  const identity = { pid: 61, startIdentity: "same", processGroupId: 61 };
  const claim = await claimDaemonLifecycle({ root, identity, daemonEpoch: "epoch", tokenPath: join(root, "daemon", "control.token"), inspect: async () => identity });
  await releaseDaemonLifecycle(claim, { preservePublication: true });

  await expect(inspectDaemonEndpoint({ root, inspect: async () => identity, probe: async () => false })).resolves.toMatchObject({ status: "UNHEALTHY", canCleanup: false });
});
