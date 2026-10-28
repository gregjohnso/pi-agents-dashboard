import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { connectOwnerSideband, OWNER_SIDEBAND_SOCKET_ENV, OWNER_SIDEBAND_TOKEN_ENV } from "../../runtime/native-sideband.mjs";
import { runManager } from "./manager.mjs";
import { probeControl } from "../../app/list/native-backend.mjs";

const controls = vi.hoisted(() => ({ hold: undefined, finish: undefined, launch: undefined }));
vi.mock("node:tty", async () => {
  const { PassThrough } = await import("node:stream");
  return { ReadStream: PassThrough };
});
vi.mock("../../runtime/pty-mechanism.mjs", () => ({
  openOwnerPty: async (options) => {
    controls.launch = options;
    let exit = null;
    const waited = new Promise((resolve) => { controls.finish = (value) => { exit = value; resolve(value); }; });
    return { masterFd: undefined, owner: { pid: 424242, startIdentity: "synthetic-owner", processGroupId: 424242 },
      reapIfExited: () => exit, wait: () => waited, resize() {}, write() {} };
  },
}));
vi.mock("./bootstrap-sideband.mjs", () => ({
  startBootstrapSideband: async (_socket, options) => {
    options.onFrame({ type: "native-readiness", readiness: { phase: "native-mounted" } });
    return { close: async () => {}, connected: () => false };
  },
}));
vi.mock("./saved-owner-record.mjs", async (original) => {
  const actual = await original();
  return { ...actual, writeSavedOwnerSnapshot: async (record, snapshot) => {
    if (controls.hold !== undefined) {
      const held = controls.hold;
      controls.hold = undefined;
      held.enter(snapshot);
      await held.promise;
    }
    return actual.writeSavedOwnerSnapshot(record, snapshot);
  } };
});

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const CANONICAL = { sessionId: "pi-one", sessionFile: "/fixture/pi/one.jsonl", sessionName: "Manual name" };
const LABELLED = { ...CANONICAL, labelVersion: 1, labelStatus: "ready", labelDescription: "Retained description" };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir().length < 60 ? tmpdir() : "/tmp", "pia-ml-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const manager = await runManager({ root: path.join(root, "runtime"), stateHome: path.join(root, "metadata"),
    cohortRoot: "/mnt/main0/home/gjohnson/projects/pi-agents-pi14-work/cohort-4189339", log: () => {}, onReady: () => {} });
  cleanup.push(async () => { controls.finish({ status: 0, code: 0, signal: null, coreDumped: false }); await manager.stop(true); });
  const recordPath = manager.statusRecord().durable.record;
  const read = async () => JSON.parse(await readFile(recordPath, "utf8"));
  const adopt = async () => {
    const before = manager.statusRecord().bridge.generation;
    const env = controls.launch.env;
    const owner = await connectOwnerSideband({ socketPath: env[OWNER_SIDEBAND_SOCKET_ENV], token: env[OWNER_SIDEBAND_TOKEN_ENV] });
    cleanup.push(() => owner.close());
    await expect.poll(() => manager.statusRecord().bridge.generation).toBe(before + 1);
    await owner.announceBridgeReady();
    return owner;
  };
  const publish = async (owner, facts) => {
    await owner.publishFacts(facts);
    await expect.poll(() => manager.statusRecord().bridge.facts).toEqual(facts);
  };
  const committed = async (afterSequence) => { await expect.poll(async () => (await read()).sequence).toBeGreaterThan(afterSequence); return read(); };
  return { manager, read, adopt, publish, committed };
}

it.each([undefined, "list"])("answers status despite oversized diagnostic history, detail=%s", async (detail) => {
  const f = await fixture();
  const owner = await f.adopt();
  await f.publish(owner, { ...LABELLED, idle: true, modelProvider: "fixture", modelId: "model" });
  const status = f.manager.statusRecord();
  status.presentations.push(...Array.from({ length: 100 }, () => ({ diagnostic: "x".repeat(400) })));
  const response = await probeControl(status.root, { type: "status", detail }, "status", { timeoutMs: 250 });
  expect(response.reachable).toBe(true);
  expect(response.answer).toMatchObject({ type: "status", detailsOmitted: true, status: { owner: status.owner, bridge: { facts: { sessionId: CANONICAL.sessionId, modelId: "model", labelStatus: "ready" } } } });
  expect(response.answer.status.presentations).toBeUndefined();
  expect(f.manager.statusRecord().presentations).toHaveLength(100);
});

it("refuses an oversized essential status explicitly instead of leaving a caller to time out", async () => {
  const f = await fixture();
  const owner = await f.adopt();
  await f.publish(owner, { ...CANONICAL, cwd: "/".repeat(4096), modelId: "x".repeat(4096) });
  const response = await probeControl(f.manager.statusRecord().root, { type: "status", detail: "list" }, "status", { timeoutMs: 250 });
  expect(response.reachable).toBe(false);
  expect(response.reason).toMatch(/^refused: .*status/iu);
});

// The manager and real descriptor-bound writer run; only native PTY/readiness and observed wait are synthetic.
it("captures queued labelled facts before replacement adoption and retains confirmed identity through absent facts", async () => {
  const f = await fixture();
  const first = await f.adopt();
  let sequence = (await f.read()).sequence;
  await f.publish(first, CANONICAL);
  sequence = (await f.committed(sequence)).sequence;
  let release;
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  controls.hold = { enter: entered, promise: new Promise((resolve) => { release = resolve; }) };
  cleanup.push(() => release());
  await f.publish(first, CANONICAL);
  const held = await entering;
  await f.publish(first, LABELLED);
  const replacement = await f.adopt();
  expect(f.manager.statusRecord().bridge.facts).toEqual({});
  await f.publish(replacement, {});
  release();
  await expect.poll(async () => (await f.read()).sequence).toBe(held.sequence + 2);
  expect(await f.read()).toMatchObject({ ...CANONICAL, labels: { description: "Retained description" } });

  sequence = (await f.read()).sequence;
  await f.publish(replacement, CANONICAL);
  expect(await f.committed(sequence)).toMatchObject({ ...CANONICAL, labels: { description: "Retained description" } });
});

it("drops descriptions for confirmed different sessions and unsupported schemas, while committing absent-facts exit evidence", async () => {
  const f = await fixture();
  const owner = await f.adopt();
  let sequence = (await f.read()).sequence;
  await f.publish(owner, LABELLED);
  sequence = (await f.committed(sequence)).sequence;
  await f.publish(owner, { sessionId: "pi-two", sessionFile: "/fixture/pi/two.jsonl" });
  const different = await f.committed(sequence);
  expect(different.labels).toBeUndefined();
  expect(different.sessionId).toBe("pi-two");
  await f.publish(owner, LABELLED);
  sequence = (await f.committed(different.sequence)).sequence;
  await f.publish(owner, { ...LABELLED, labelVersion: 99 });
  const unsupported = await f.committed(sequence);
  expect(unsupported.labels).toBeUndefined();
  await f.publish(owner, CANONICAL);
  const unlabeled = await f.committed(unsupported.sequence);
  expect(unlabeled.labels).toBeUndefined();

  await f.adopt();
  expect(f.manager.statusRecord().bridge.facts).toEqual({});
  controls.finish({ status: 0, code: 0, signal: null, coreDumped: false });
  const exited = await f.committed(unlabeled.sequence);
  expect(exited).toMatchObject({ ...CANONICAL, exit: { status: 0, code: 0, disposition: "exited-on-its-own" } });
  expect(exited.labels).toBeUndefined();
});
