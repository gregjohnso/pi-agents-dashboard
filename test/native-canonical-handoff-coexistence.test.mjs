/**
 * Coexistence acceptance: seam D's canonical admission and seam G's recognized child handoff in one owner.
 *
 * Each seam has its own acceptance suite, and neither can state this: seam D's suite registers no attachment
 * host and never drains, seam G's registers no canonical host and never admits an operation. This file drives
 * both from **one** installed cohort in **one** process, so the two owner-side critical sections overlap the
 * way they will in production: seam D consumes its one-use reservation inside seam A's synchronous section,
 * and seam G closes labelled admission, releases the terminal to the recognized child and reopens it around
 * that same owner.
 *
 * `PI_SEAM_D_CONSUMER` selects the runtime half and `PI_NATIVE_ARTIFACTS_MANIFEST` the terminal half; both
 * must name the same cohort, which the first assertion checks by module identity rather than by trusting the
 * two variables. With either unset the file skips, because these cases cannot be run against a checkout.
 *
 * What these cases do not claim: the canonical host is the same fake stand-in seam D's own suite uses, so
 * nothing here is evidence about durable reservations, fsync, locking, reconciliation or the pre-spawn
 * startup reservation. The child is a recorded site around Pi's real bracket, not an arbitrary child, and no
 * Gate 5 claim follows from it.
 */

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachment,
  dispatch,
  newAttachmentNamespace,
  startCapturingTerminal,
} from "./fixtures/native-ingress/built-pipeline.mjs";
import { importBuiltHandoffIfSelected, recordingSite } from "./fixtures/native-child-handoff/built-handoff.mjs";
import {
  CONSUMER,
  createFakeCanonicalHost,
  createInstalledRuntime,
  importInstalled,
} from "./fixtures/native-canonical/installed-runtime.mjs";

const { selected, tui, codingAgent, manifest } = await importBuiltHandoffIfSelected();
const describeCohort = selected && CONSUMER ? describe : describe.skip;

/** One profile for the whole file: the launch profile is fixed by the first registration in this process. */
const PROFILE = {
  profileId: "canonical-handoff-coexistence-profile",
  term: "xterm-256color",
  capabilities: {
    kittyKeyboard: true,
    kittyGraphics: false,
    mouse: true,
    bracketedPaste: true,
    synchronizedOutput: true,
    trueColor: true,
  },
  cellSize: null,
};

let pi;
let owners = 0;
let registration;
let unsubscribes = [];
let capture;
const openRuntimes = [];

beforeEach(async () => {
  newAttachmentNamespace();
  pi = await importInstalled("@earendil-works/pi-coding-agent");
});

afterEach(() => {
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
  registration?.release();
  registration = undefined;
  capture?.stop();
  capture = undefined;
  if (pi?.setNativeSubmissionHost) pi.setNativeSubmissionHost(undefined);
  while (openRuntimes.length > 0) openRuntimes.pop().dispose();
});

/** The seam A host carrying seam D's trio, registered through the public entry point. */
function activateCanonicalHost(overrides) {
  const host = createFakeCanonicalHost(`coexistence-owner-${++owners}`, overrides);
  pi.setNativeSubmissionHost(host);
  return host;
}

/** The seam B/C/F host, opted into this build's seam G version. */
function registerAttachmentHost() {
  registration = tui.registerNativeAttachmentHost({
    profile: PROFILE,
    authorizeReturn: () => "native",
    beforeApplyTerminalResponse: async () => ({ apply: true }),
    childTerminalHandoff: { version: tui.SUPPORTED_CHILD_TERMINAL_HANDOFF_VERSION },
  });
}

function recordPhases() {
  const phases = [];
  unsubscribes.push(tui.onChildTerminalPhase((phase) => phases.push(phase)));
  return phases;
}

async function startRuntime() {
  const harness = await createInstalledRuntime();
  openRuntimes.push(harness);
  return harness;
}

/**
 * Run Pi's own recognized-handoff bracket over the real terminal, dispatching one labelled span while the
 * child owns it. `onStop`/`onRestore` are the renderer operations Pi really performs.
 */
async function bracketWithDispatchInsideChild(client) {
  const duringChild = [];
  const { site, order } = recordingSite({
    terminal: capture.terminal,
    onStop: () => capture.terminal.stop(),
    onRestore: () =>
      capture.terminal.start(
        (data, provenance) => capture.delivered.push({ data, provenance }),
        () => {},
      ),
    child: async () => {
      duringChild.push(await dispatch(capture.terminal, client, "b"));
      return { status: "complete", content: "edited" };
    },
  });
  const report = await codingAgent.bracketRecognizedChildTerminal(site);
  return { report, order, duringChild };
}

describeCohort(`seam D and seam G in one owner, against the ${manifest.mode} cohort`, () => {
  it("resolves both seams from one installed coding-agent module in one cohort", () => {
    expect(path.resolve(CONSUMER)).toBe(manifest.consumerRoot);
    // One module instance, so the canonical coordinator the runtime half drives is the one the handoff
    // bracket shares. Two instances would make every later assertion vacuous.
    expect(pi.setNativeSubmissionHost).toBe(codingAgent.setNativeSubmissionHost);
    expect(typeof codingAgent.bracketRecognizedChildTerminal).toBe("function");
    expect(pi.nativeCanonicalCapability().seam).toBe("D");
    expect(tui.SUPPORTED_CHILD_TERMINAL_HANDOFF_VERSION).toBe(1);
  });

  it("runs a recognized handoff inside a managed owner and leaves the canonical coordinator untouched", async () => {
    const host = activateCanonicalHost();
    registerAttachmentHost();
    const phases = recordPhases();
    const harness = await startRuntime();
    harness.persist(harness.runtime.session.sessionManager);
    await harness.runtime.newSession();
    expect(host.operations()).toEqual(["startup", "new"]);
    expect(host.committed).toHaveLength(2);

    capture = startCapturingTerminal(tui);
    const client = attachment("coexistence-client");
    expect(await dispatch(capture.terminal, client, "a")).toEqual({ admitted: true, consumedThrough: 1 });
    const { report, order, duringChild } = await bracketWithDispatchInsideChild(client);

    expect(report).toMatchObject({ entered: true, managed: true, outcome: "returned" });
    expect(order).toEqual(["release", "stop", "child", "applyResult", "restore", "reclaim"]);
    expect(duringChild[0]).toEqual({ admitted: false, consumedThrough: 1, reason: "handoff-closed" });
    expect(phases.map((phase) => phase.phase)).toEqual(["entering", "left"]);
    // The handoff is not a canonical operation: it admitted nothing, committed nothing and aborted no
    // reservation this owner holds.
    expect(host.operations()).toEqual(["startup", "new"]);
    expect(host.committed).toHaveLength(2);
    expect(host.aborted).toEqual([]);

    // Both seams still work afterwards: labelled admission reopened, and a canonical operation still admits
    // the exact target and commits one advanced generation.
    expect(await dispatch(capture.terminal, client, "c")).toEqual({ admitted: true, consumedThrough: 2 });
    await harness.runtime.newSession();
    expect(host.operations()).toEqual(["startup", "new", "new"]);
    expect(host.targets().at(-1)).toBe(harness.runtime.session.sessionManager.getSessionFile());
    expect(host.committed).toHaveLength(3);
    expect(host.committed.at(-1).nextGeneration).toBe(host.committed.at(-2).nextGeneration + 1);
    expect(capture.delivered.map((entry) => entry.data)).toEqual(["a", "c"]);
  });

  it("keeps each seam's own refusal while the canonical commit is unresolved", async () => {
    // The startup adoption commits; the rebind's commit receipt is lost, which is seam D's permanent
    // fail-closed state for later canonical work and for seam A.
    const host = activateCanonicalHost();
    host.commit = async () => {
      if (host.committed.length >= 2) throw new Error("commit receipt lost");
    };
    registerAttachmentHost();
    const phases = recordPhases();
    const harness = await startRuntime();
    harness.persist(harness.runtime.session.sessionManager);
    await expect(harness.runtime.newSession()).rejects.toMatchObject({ code: "PERSISTENCE_UNCERTAIN" });
    await expect(
      harness.runtime.session.prompt("blocked", { nativeSubmit: { source: "startup-prompt" } }),
    ).rejects.toThrow(/PERSISTENCE_UNCERTAIN/);

    capture = startCapturingTerminal(tui);
    const client = attachment("coexistence-client");
    expect(await dispatch(capture.terminal, client, "a")).toEqual({ admitted: true, consumedThrough: 1 });
    const { report, duringChild } = await bracketWithDispatchInsideChild(client);

    // Seam G answers with seam G's verdict: the closed gate is `handoff-closed`, not seam D's code, the pair
    // is announced, and admission reopens. Labelled ingress is not what seam D fails closed.
    expect(report).toMatchObject({ entered: true, managed: true, outcome: "returned" });
    expect(duringChild[0]).toEqual({ admitted: false, consumedThrough: 1, reason: "handoff-closed" });
    expect(phases.map((phase) => phase.phase)).toEqual(["entering", "left"]);
    expect(await dispatch(capture.terminal, client, "c")).toEqual({ admitted: true, consumedThrough: 2 });

    // And the handoff resolved nothing for seam D: the owner is still uncertain, still commits nothing and
    // still aborts no retained reservation.
    await expect(harness.runtime.newSession()).rejects.toMatchObject({ code: "PERSISTENCE_UNCERTAIN" });
    expect(host.committed).toHaveLength(2);
    expect(host.aborted).toEqual([]);
  });
});
