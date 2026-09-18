import { access, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

import {
  abandonDaemonStartChild,
  claimDaemonLifecycle,
  identifyDaemonChild,
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

it.each([
  ["a reused PID, so cleanup is authorized", { pid: 51, startIdentity: "reused", processGroupId: 51 }, { status: "STALE", canCleanup: true }],
  ["the exact recorded identity, so nothing may be unlinked", { pid: 51, startIdentity: "old", processGroupId: 51 }, { status: "UNHEALTHY", canCleanup: false }],
])("reports an unreachable published daemon running under %s", async (_label, observed, expected) => {
  const root = await fixture();
  const identity = { pid: 51, startIdentity: "old", processGroupId: 51 };
  const claim = await claimDaemonLifecycle({ root, identity, daemonEpoch: "epoch", tokenPath: join(root, "daemon", "control.token"), inspect: async () => identity });
  await releaseDaemonLifecycle(claim, { preservePublication: true });

  await expect(inspectDaemonEndpoint({ root, inspect: async () => observed, probe: async () => false })).resolves.toMatchObject(expected);
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

/** @param {string} root @param {any} identity @param {string} state */
async function publish(root, identity, state) {
  await writeFile(join(root, "daemon", "pid.json"), JSON.stringify({
    schemaVersion: 1, ...identity, daemonEpoch: "epoch", tokenPath: join(root, "daemon", "control.token"),
    startedAt: "2026-08-25T12:00:00.000Z", state,
  }), { mode: 0o600 });
}

/** A cleanup caller has to identify itself, so every fake inspector answers for this process too. */
const selfIdentity = { pid: process.pid, startIdentity: "1", processGroupId: process.pid };

/** @param {number} pid */
function noSuchProcess(pid) {
  return Object.assign(new Error(`no such process ${pid}`), { code: "ESRCH" });
}

it.each([
  ["leads its own process group, so it can be signalled", { pid: 4242, startIdentity: "111222333", processGroupId: 4242 }, { status: "IDENTIFIED", pid: 4242 }],
  ["belongs to a group another process leads, so its PID was reused", { pid: 4242, startIdentity: "111222333", processGroupId: 17 }, { status: "UNVERIFIED", pid: 4242 }],
])("identifies a spawned daemon child that %s", async (_label, observed, expected) => {
  await expect(identifyDaemonChild({ pid: 4242 }, async () => observed)).resolves.toMatchObject(expected);
});

it.each([
  ["exited before it could be identified", { pid: 4242 }, async () => { throw noSuchProcess(4242); }, { status: "EXITED", pid: 4242 }],
])("identifies a spawned daemon child that %s", async (_label, child, inspect, expected) => {
  await expect(identifyDaemonChild(child, inspect)).resolves.toEqual(expected);
});

it("stops an abandoned daemon child through its verified process group", async () => {
  // A start that gave up left its detached child running, and the child published itself seconds
  // later and lived forever: 47 test daemons leaked in one night, the oldest up 38 hours.
  const root = await fixture();
  const identity = { pid: 4242, startIdentity: "111222333", processGroupId: 4242 };
  await publish(root, identity, "STARTING");
  let alive = true;
  /** @type {any[][]} */
  const signals = [];
  const spawned = await identifyDaemonChild({ pid: identity.pid }, async () => identity);

  const abandoned = await abandonDaemonStartChild(spawned, {
    root,
    inspect: async (/** @type {number} */ pid) => {
      if (pid === process.pid) return selfIdentity;
      if (pid === identity.pid && alive) return identity;
      throw noSuchProcess(pid);
    },
    signalProcessGroup: (/** @type {number} */ pgid, /** @type {string} */ signal) => { signals.push([pgid, signal]); alive = false; },
    stopPolicy: { gracefulMs: 1, terminateMs: 1 },
  });

  expect(signals).toEqual([[4242, "SIGTERM"]]);
  expect(abandoned).toMatchObject({ pid: 4242, proven: true, disposition: "TERMINATED", cleanedPublication: true });
  // The child published before it was stopped, so leaving that endpoint behind would refuse the
  // operator's next start with STALE_ENDPOINT_REQUIRES_RECOVER.
  await expect(access(join(root, "daemon", "pid.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("never signals an abandoned daemon child whose identity it could not verify", async () => {
  const root = await fixture();
  /** @type {any[][]} */
  const signals = [];
  const spawned = await identifyDaemonChild({ pid: 4242 }, async () => ({ pid: 4242, startIdentity: "111222333", processGroupId: 17 }));

  const abandoned = await abandonDaemonStartChild(spawned, {
    root,
    inspect: async () => selfIdentity,
    signalProcessGroup: (/** @type {number} */ pgid, /** @type {string} */ signal) => { signals.push([pgid, signal]); },
    stopPolicy: { gracefulMs: 1, terminateMs: 1 },
  });

  expect(signals).toEqual([]);
  expect(abandoned).toMatchObject({ pid: 4242, proven: false, disposition: "UNVERIFIED" });
  expect(abandoned.summary).toContain("4242");
});

it("leaves an endpoint another daemon published where it is", async () => {
  const root = await fixture();
  const other = { pid: 77, startIdentity: "770", processGroupId: 77 };
  await publish(root, other, "READY");
  const child = { pid: 4242, startIdentity: "111222333", processGroupId: 4242 };
  const spawned = await identifyDaemonChild({ pid: child.pid }, async () => child);

  const abandoned = await abandonDaemonStartChild(spawned, {
    root,
    inspect: async (/** @type {number} */ pid) => {
      if (pid === process.pid) return selfIdentity;
      if (pid === other.pid) throw noSuchProcess(pid);
      throw noSuchProcess(pid);
    },
    signalProcessGroup: () => { throw new Error("an exited child must not be signalled"); },
    stopPolicy: { gracefulMs: 1, terminateMs: 1 },
  });

  expect(abandoned).toMatchObject({ proven: true, disposition: "ALREADY_EXITED", cleanedPublication: false });
  expect(JSON.parse(await readFile(join(root, "daemon", "pid.json"), "utf8"))).toMatchObject({ pid: 77 });
});

it("reports an abandoned daemon child that survived every signal instead of claiming it is gone", async () => {
  const root = await fixture();
  const identity = { pid: 4242, startIdentity: "111222333", processGroupId: 4242 };
  /** @type {any[][]} */
  const signals = [];
  const spawned = await identifyDaemonChild({ pid: identity.pid }, async () => identity);

  const abandoned = await abandonDaemonStartChild(spawned, {
    root,
    inspect: async (/** @type {number} */ pid) => (pid === process.pid ? selfIdentity : identity),
    signalProcessGroup: (/** @type {number} */ pgid, /** @type {string} */ signal) => { signals.push([pgid, signal]); },
    stopPolicy: { gracefulMs: 1, terminateMs: 1 },
  });

  expect(signals).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  expect(abandoned).toMatchObject({ pid: 4242, proven: false, disposition: "KILL_REQUESTED" });
});

it("refuses an unowned socket instead of unlinking a possibly live daemon", async () => {
  const root = await fixture();
  const socketPath = join(root, "daemon", "control.sock");
  await writeFile(socketPath, "live-owner");
  const identity = { pid: 81, startIdentity: "800", processGroupId: 81 };
  await expect(claimDaemonLifecycle({ root, identity, daemonEpoch: "epoch", tokenPath: join(root, "daemon", "control.token"), inspect: async () => identity })).rejects.toMatchObject({ code: "DAEMON_IDENTITY_CONFLICT" });
  await expect(access(socketPath)).resolves.toBeUndefined();
});
