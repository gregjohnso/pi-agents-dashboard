import { access, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

it("recovers an exact crashed transaction without letting the old owner unlink the replacement", async () => {
  const root = await fixture();
  const oldIdentity = { pid: 70, startIdentity: "700", processGroupId: 70 };
  const newIdentity = { pid: 70, startIdentity: "701", processGroupId: 70 };
  let actual = oldIdentity;
  const inspect = async () => actual;
  const oldClaim = await claimDaemonLifecycle({ root, identity: oldIdentity, daemonEpoch: "old", tokenPath: join(root, "daemon", "control.token"), inspect });
  actual = newIdentity;
  const newClaim = await claimDaemonLifecycle({ root, identity: newIdentity, daemonEpoch: "new", tokenPath: join(root, "daemon", "control.token"), inspect });
  await releaseDaemonLifecycle(oldClaim);
  expect((await inspectDaemonEndpoint({ root, inspect, probe: async () => true })).publication.daemonEpoch).toBe("new");
  await releaseDaemonLifecycle(newClaim);
});

it("keeps a lifecycle transaction held through publication cleanup", async () => {
  const root = await fixture();
  const identity = { pid: 71, startIdentity: "700", processGroupId: 71 };
  const claim = await claimDaemonLifecycle({ root, identity, daemonEpoch: "epoch", tokenPath: join(root, "daemon", "control.token"), inspect: async () => identity });
  await rm(join(root, "daemon", "pid.json"));
  await expect(claimDaemonLifecycle({ root, identity, daemonEpoch: "other", tokenPath: join(root, "daemon", "control.token"), inspect: async () => identity })).rejects.toMatchObject({ code: "DAEMON_BUSY" });
  await releaseDaemonLifecycle(claim);
});

it("reports publication read errors and releases both lifecycle locks once", async () => {
  const root = await fixture();
  const publication = { schemaVersion: 1, pid: 81, startIdentity: "800", processGroupId: 81, daemonEpoch: "epoch", tokenPath: join(root, "daemon", "control.token"), startedAt: "2026-08-25T12:00:00.000Z", state: "READY" };
  let publicationRemovals = 0;
  let lockReleases = 0;
  let transactionReleases = 0;
  const claim = {
    root,
    publication,
    lock: { async release() { lockReleases += 1; throw new Error("injected lifecycle lock release failure"); } },
    transaction: { async release() { transactionReleases += 1; throw new Error("injected transaction release failure"); } },
  };
  const fsOps = {
    async lstat() { throw Object.assign(new Error("injected publication read failure"), { code: "EIO" }); },
    async rm() { publicationRemovals += 1; },
  };
  await expect(releaseDaemonLifecycle(claim, { fsOps })).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ code: "DAEMON_IDENTITY_CONFLICT" }),
      expect.objectContaining({ message: "injected lifecycle lock release failure" }),
      expect.objectContaining({ message: "injected transaction release failure" }),
    ],
  });
  expect(publicationRemovals).toBe(0);
  expect(lockReleases).toBe(1);
  expect(transactionReleases).toBe(1);
});

it("attempts socket, PID, and lock cleanup independently before exact recovery", async () => {
  const root = await fixture();
  const oldIdentity = { pid: 82, startIdentity: "800", processGroupId: 82 };
  const newIdentity = { pid: 82, startIdentity: "801", processGroupId: 82 };
  let actual = oldIdentity;
  const inspect = async () => actual;
  const claim = await claimDaemonLifecycle({ root, identity: oldIdentity, daemonEpoch: "old", tokenPath: join(root, "daemon", "control.token"), inspect });
  await writeFile(join(root, "daemon", "control.sock"), "old socket");
  /** @type {string[]} */
  const removals = [];
  const fsOps = {
    lstat,
    readFile,
    /** @param {string} path @param {any} options */
    async rm(path, options) {
      removals.push(path);
      if (path.endsWith("control.sock")) throw new Error("injected socket unlink failure");
      if (path.endsWith("pid.json")) throw new Error("injected PID unlink failure");
      return rm(path, options);
    },
  };
  await expect(releaseDaemonLifecycle(claim, { fsOps })).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: "injected socket unlink failure" }),
      expect.objectContaining({ message: "injected PID unlink failure" }),
    ],
  });
  expect(removals).toEqual([
    join(root, "daemon", "control.sock"),
    join(root, "daemon", "pid.json"),
  ]);

  actual = newIdentity;
  const replacement = await claimDaemonLifecycle({ root, identity: newIdentity, daemonEpoch: "new", tokenPath: join(root, "daemon", "control.token"), inspect });
  expect((await inspectDaemonEndpoint({ root, inspect, probe: async () => true })).publication.daemonEpoch).toBe("new");
  await releaseDaemonLifecycle(replacement);
});

it("refuses an unowned socket instead of unlinking a possibly live daemon", async () => {
  const root = await fixture();
  const socketPath = join(root, "daemon", "control.sock");
  await writeFile(socketPath, "live-owner");
  const identity = { pid: 81, startIdentity: "800", processGroupId: 81 };
  await expect(claimDaemonLifecycle({ root, identity, daemonEpoch: "epoch", tokenPath: join(root, "daemon", "control.token"), inspect: async () => identity })).rejects.toMatchObject({ code: "DAEMON_IDENTITY_CONFLICT" });
  await expect(access(socketPath)).resolves.toBeUndefined();
});

it("reports a live but unreachable daemon unhealthy without authorizing unlink", async () => {
  const root = await fixture();
  const identity = { pid: 61, startIdentity: "same", processGroupId: 61 };
  const claim = await claimDaemonLifecycle({ root, identity, daemonEpoch: "epoch", tokenPath: join(root, "daemon", "control.token"), inspect: async () => identity });
  await releaseDaemonLifecycle(claim, { preservePublication: true });

  await expect(inspectDaemonEndpoint({ root, inspect: async () => identity, probe: async () => false })).resolves.toMatchObject({ status: "UNHEALTHY", canCleanup: false });
});
