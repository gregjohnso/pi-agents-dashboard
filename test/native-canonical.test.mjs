/**
 * Seam D acceptance: canonical admission on exact names, exercised through an installed Pi artifact.
 *
 * The seam is Pi's, so every assertion drives real Pi code from an installed package: the packaged
 * `AgentSessionRuntime`, `SessionManager` and canonical coordinator, reached only through the public API a
 * host actually has — `setNativeSubmissionHost` with the canonical trio on the registered host. Point
 * `PI_SEAM_D_CONSUMER` at a directory whose `node_modules` holds the cohort to exercise:
 *
 *   - a consumer built from `vendor/pi/` with the seam D patch applied -> these cases pass
 *   - an unpatched Pi 0.84.3 install                                  -> the managed matrix fails on the
 *     behaviour the patch adds (admission before the write, exact names, fail-closed commits)
 *
 * Without the variable the managed matrix is skipped, so the default suite stays green and never collects a
 * known-red baseline. The one always-on case is unmanaged compatibility, which must hold on a patched and an
 * unpatched install alike.
 *
 * The fake host is a faithful stand-in for pi-agents' reservation obligations, not the durable Task 14
 * journal. Nothing here proves fsync, locking, reconciliation, or the pre-spawn startup reservation that
 * Task 16 owns: the `startup` operation seen here is the post-registration adoption of a binding Pi already
 * had.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CONSUMER,
  COHORT_ROOT,
  createFakeCanonicalHost,
  createInstalledRuntime,
  createSubmissionOnlyHost,
  importInstalled,
  resolveInstalled,
} from "./fixtures/native-canonical/installed-runtime.mjs";

let pi;
let owners = 0;
const openRuntimes = [];

beforeAll(async () => {
  const entry = resolveInstalled(COHORT_ROOT, "@earendil-works/pi-coding-agent");
  pi = await importInstalled("@earendil-works/pi-coding-agent");
  console.log(`seam D acceptance resolved coding-agent from ${entry}`);
});

afterEach(() => {
  if (pi?.setNativeSubmissionHost) pi.setNativeSubmissionHost(undefined);
  while (openRuntimes.length > 0) openRuntimes.pop().dispose();
});

async function startRuntime() {
  const harness = await createInstalledRuntime();
  openRuntimes.push(harness);
  return harness;
}

function activate(host) {
  expect(typeof pi.setNativeSubmissionHost).toBe("function");
  pi.setNativeSubmissionHost(host);
}

function newHost(overrides) {
  return createFakeCanonicalHost(`seam-d-owner-${++owners}`, overrides);
}

describe("seam D: the required runtime", () => {
  it("runs on Node >=22.19.0 <23, the runtime the plan pins", () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    console.log(`seam D acceptance runtime ${process.version} execPath=${process.execPath}`);
    expect(`${major}`, `unexpected Node ${process.version} at ${process.execPath}`).toBe("22");
    expect(minor).toBeGreaterThanOrEqual(19);
  });
});

describe("seam D: unmanaged Pi is unchanged", () => {
  it("creates a new session with no host registered and asks nothing of any host", async () => {
    if (pi.setNativeSubmissionHost) pi.setNativeSubmissionHost(undefined);
    const harness = await startRuntime();
    const before = harness.runtime.session.sessionManager.getSessionFile();
    const result = await harness.runtime.newSession();
    expect(result.cancelled).toBe(false);
    expect(harness.runtime.session.sessionManager.getSessionFile()).not.toBe(before);
  });
});

describe.skipIf(!CONSUMER)("seam D: canonical admission, through the installed artifact", () => {
  it("D-1 registers the canonical trio together, and rejects a partial one", async () => {
    const host = newHost();
    expect(() => activate(host)).not.toThrow();
    const partial = { ...createSubmissionOnlyHost(host.ownerRunId), admitCanonicalOperation: host.admitCanonicalOperation };
    expect(() => activate(partial)).toThrow(/all together or not at all/);
  });

  it("D-2 leaves canonical behaviour unmanaged for a seam A host with no trio", async () => {
    const submissionOnly = createSubmissionOnlyHost(`seam-d-owner-${++owners}`);
    activate(submissionOnly);
    const harness = await startRuntime();
    const result = await harness.runtime.newSession();
    expect(result.cancelled).toBe(false);
    expect(submissionOnly.admitted).toHaveLength(0);
  });

  it("D-3 admits the exact new file before it exists, then commits the advanced generation once", async () => {
    const host = newHost();
    activate(host);
    const harness = await startRuntime();
    harness.persist(harness.runtime.session.sessionManager);
    const ownFile = harness.runtime.session.sessionManager.getSessionFile();
    expect(existsSync(ownFile)).toBe(true);
    const generationBefore = host.admitted.length;
    await harness.runtime.newSession();
    const created = harness.runtime.session.sessionManager.getSessionFile();
    // Startup adoption of the file Pi already had, then the new file, resolved exactly and admitted before
    // anything was written to it.
    expect(host.operations()).toEqual(["startup", "new"]);
    expect(host.targets()).toEqual([ownFile, created]);
    expect(generationBefore).toBe(0);
    const [startup, rebind] = host.committed;
    expect(rebind.nextGeneration).toBe(startup.nextGeneration + 1);
    expect(host.aborted).toHaveLength(0);
    // The owner's binding, as seam A reports it in a submission envelope, carries that committed generation.
    await harness.runtime.session.prompt("bound", { nativeSubmit: { source: "startup-prompt" } });
    expect(host.envelopes.at(-1).binding).toEqual({ canonicalFile: created, generation: rebind.nextGeneration });
  });

  it("D-4 fails an admitted fork whose exact name was taken, aborts once, and overwrites nothing", async () => {
    const host = newHost();
    activate(host);
    const harness = await startRuntime();
    const manager = harness.runtime.session.sessionManager;
    harness.persist(manager);
    const leaf = manager.getEntries().at(-1).id;
    // The squatter is created on the exact name the fork will resolve, after admission decides it.
    host.decide = async (operation) => {
      if (operation.operation === "fork") writeFileSync(operation.resolvedTarget.canonicalFile, "squatter\n");
      return { reservationId: `reservation-${++host.reservations}` };
    };
    await expect(harness.runtime.fork(leaf, { position: "at" })).rejects.toThrow(/EEXIST|exists/);
    const forkTarget = host.admitted.at(-1).resolvedTarget.canonicalFile;
    expect(readFileSync(forkTarget, "utf8")).toBe("squatter\n");
    expect(host.aborted).toHaveLength(1);
    expect(host.committed.map((entry) => entry.reservationId)).toEqual(["reservation-1"]);
  });

  it("D-5 refuses a resume onto a live-writer target visibly, writes nothing, and keeps resume usable", async () => {
    const host = newHost();
    activate(host);
    const harness = await startRuntime();
    harness.persist(harness.runtime.session.sessionManager);
    const ownFile = harness.runtime.session.sessionManager.getSessionFile();
    const other = path.join(harness.sessions, "2026-01-01T00-00-00-000Z_other.jsonl");
    const otherBytes = `${JSON.stringify({ type: "session", version: 3, id: "other", timestamp: new Date().toISOString(), cwd: harness.root })}\n`;
    writeFileSync(other, otherBytes);
    host.decide = async (operation) =>
      operation.operation === "resume"
        ? { refused: true, code: "TARGET_HAS_LIVE_WRITER", message: "owner pi-7 is writing it" }
        : { reservationId: `reservation-${++host.reservations}` };

    await expect(harness.runtime.switchSession(other)).rejects.toMatchObject({
      name: "CanonicalOperationRefusedError",
      code: "TARGET_HAS_LIVE_WRITER",
      beforeMutation: true,
    });
    expect(readFileSync(other, "utf8")).toBe(otherBytes);
    expect(harness.runtime.session.sessionManager.getSessionFile()).toBe(ownFile);
    expect(host.aborted).toHaveLength(0);
    // Nothing was disabled: the same command succeeds once the host admits it.
    host.decide = async () => ({ reservationId: `reservation-${++host.reservations}` });
    const resumed = await harness.runtime.switchSession(other);
    expect(resumed.cancelled).toBe(false);
    expect(harness.runtime.session.sessionManager.getSessionFile()).toBe(other);
  });

  it("D-6 treats an unrecognised decision, including a v1 forwardTo arm, as unavailable and forwards nothing", async () => {
    for (const decision of [
      { forwardTo: { canonicalFile: "/elsewhere.jsonl" } },
      { reservationId: "" },
      undefined,
    ]) {
      const host = newHost();
      activate(host);
      const harness = await startRuntime();
      harness.persist(harness.runtime.session.sessionManager);
      const ownFile = harness.runtime.session.sessionManager.getSessionFile();
      host.decide = async (operation) =>
        operation.operation === "startup" ? { reservationId: "startup" } : decision;
      await expect(harness.runtime.newSession(), JSON.stringify(decision ?? null)).rejects.toMatchObject({
        name: "CanonicalOperationRefusedError",
        code: "ADMISSION_UNAVAILABLE",
      });
      expect(harness.runtime.session.sessionManager.getSessionFile()).toBe(ownFile);
      expect(host.committed.map((entry) => entry.reservationId)).toEqual(["startup"]);
    }
  });

  it("D-7 imports onto the exact destination and never overwrites an existing session file", async () => {
    const host = newHost();
    activate(host);
    const harness = await startRuntime();
    harness.persist(harness.runtime.session.sessionManager);
    const source = path.join(harness.root, "exported.jsonl");
    writeFileSync(
      source,
      `${JSON.stringify({ type: "session", version: 3, id: "exported", timestamp: new Date().toISOString(), cwd: harness.root })}\n`,
    );
    const destination = path.join(harness.sessions, "exported.jsonl");
    const squatter = "not yours\n";
    writeFileSync(destination, squatter);
    await expect(harness.runtime.importFromJsonl(source)).rejects.toThrow(/EEXIST|exists/);
    expect(readFileSync(destination, "utf8")).toBe(squatter);
    expect(host.admitted.at(-1)).toMatchObject({ operation: "import", resolvedTarget: { canonicalFile: destination } });
    expect(host.aborted).toHaveLength(1);
  });

  it("D-8 fails closed with PERSISTENCE_UNCERTAIN after a lost commit receipt, for canonical work and for seam A", async () => {
    const host = newHost();
    // The startup adoption commits; the rebind's commit receipt is lost.
    host.commit = async () => {
      if (host.committed.length >= 2) throw new Error("commit receipt lost");
    };
    activate(host);
    const harness = await startRuntime();
    harness.persist(harness.runtime.session.sessionManager);
    await expect(harness.runtime.newSession()).rejects.toMatchObject({ code: "PERSISTENCE_UNCERTAIN" });
    // No rollback, no replay, no second commit and no abort of the retained reservation.
    expect(host.committed).toHaveLength(2);
    expect(host.aborted).toHaveLength(0);
    await expect(harness.runtime.newSession()).rejects.toMatchObject({ code: "PERSISTENCE_UNCERTAIN" });
    expect(host.committed).toHaveLength(2);
    // A submission is refused at the boundary, before any queue or command mutation.
    await expect(
      harness.runtime.session.prompt("blocked", { nativeSubmit: { source: "startup-prompt" } }),
    ).rejects.toThrow(/PERSISTENCE_UNCERTAIN/);
  });

  it("D-9 reports seam D truthfully and claims no host durability, startup reservation or forwarding", async () => {
    const capability = pi.nativeCanonicalCapability();
    expect(capability).toBe(pi.NATIVE_CANONICAL_CAPABILITY);
    expect(capability.seam).toBe("D");
    expect(capability.version).toBe(1);
    const notDelivered = capability.notDelivered.join(" ");
    for (const claim of ["Task 14", "Task 16", "forwardTo", "gate 5"]) expect(notDelivered).toContain(claim);
    expect(typeof pi.CanonicalOperationRefusedError).toBe("function");
  });
});
