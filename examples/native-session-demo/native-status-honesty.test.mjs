/**
 * Four corrections, each pinned by the condition the parent probed.
 *
 * The theme is that hidden metadata is not a disclosure: what the operator reads is the rendered STATE cell and
 * the action the row offers, so these cases assert `displaySessionState` and `destructiveAction` output rather
 * than the flags behind them.
 */

import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNativeBackend, rowStateFromStatus, describeOwnerActivity } from "../../app/list/native-backend.mjs";
import { parseModelCatalogue } from "../../app/list/native-model-catalogue.mjs";
import { displaySessionState } from "../../app/list/session-state.mjs";
import { destructiveAction } from "../../app/list/dashboard-overlays.mjs";
import { selectDashboardSessions } from "../../app/list/dashboard-state.mjs";

/** The row the existing renderer is actually handed, built the way `getState` builds it. */
async function rowFor(status, { observedExit } = {}) {
  const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-honesty-"));
  const root = path.join(sessionsHome, "session-1789000000000");
  await mkdir(root, { recursive: true });
  const client = createNativeBackend({
    sessionsHome,
    listModels: async () => "provider  model\nfixture  one  1K  10  no  no",
    askControl: async () => (status === undefined ? { reachable: false, reason: "no control socket" } : { reachable: true, answer: { status } }),
  });
  if (observedExit !== undefined) {
    client.noteObservedExit?.(path.basename(root), observedExit);
  }
  const { sessions } = await client.getState();
  client.close();
  return sessions[0];
}

const LIVE_NO_FACTS = { owner: { pid: 11 }, attachments: [], exit: null, reaped: null, bridge: { connected: true, facts: {} } };
const LIVE_SETTLED = { owner: { pid: 11 }, attachments: [], exit: null, reaped: null, bridge: { connected: true, facts: { agentPhase: "settled", idle: true, pendingMessages: false } } };

describe("1. an unknown state is visibly unknown, and unreachable is not an exit", () => {
  it("renders a live owner that has published nothing as unknown, not READY", async () => {
    const row = await rowFor(LIVE_NO_FACTS);
    // What the operator actually reads in the STATE column.
    expect(displaySessionState(row)).not.toBe("READY");
    expect(displaySessionState(row)).toBe("UNKNOWN");
  });

  it("renders an unreachable owner as stale rather than exited or stopped", async () => {
    const row = await rowFor(undefined);
    // A failed connection is not evidence of exit.
    expect(row.processState).toBe("STALE");
    expect(row.taskState).not.toBe("STOPPED");
    expect(row.taskState).not.toBe("FAILED");
    expect(displaySessionState(row)).toBe("STALE");
    expect(describeOwnerActivity(rowStateFromStatus(undefined))).toMatch(/could not be reached/u);
  });

  it("still renders an explicit observed exit correctly", () => {
    const stopped = rowStateFromStatus(undefined, { observedExit: { status: 0, code: 0, signal: null } });
    const failed = rowStateFromStatus(undefined, { observedExit: { status: 3, code: 3, signal: null } });
    const asRow = (state) => ({ ...state, activity: { kind: "exited", summary: "" } });
    expect(displaySessionState(asRow(stopped))).toBe("STOPPED");
    expect(displaySessionState(asRow(failed))).toBe("FAILED");
  });

  it("still renders a known live state as that state", async () => {
    const row = await rowFor(LIVE_SETTLED);
    expect(displaySessionState(row)).toBe("READY");
  });

  it("offers an action for an unreachable row that never claims the owner is gone", async () => {
    const row = await rowFor(undefined);
    const action = destructiveAction(row);
    // Whatever the existing rule offers, it must not be a silent no-op or a false success: `delete` is
    // answered by name, and `stop` goes through the authenticated path.
    expect(["stop", "delete"]).toContain(action);
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-honesty-"));
    const client = createNativeBackend({ sessionsHome, listModels: async () => "provider  model" });
    if (action === "delete") {
      await expect(client.delete(row.sessionId, row.revision, "r")).rejects.toMatchObject({ code: "ACTION_UNSUPPORTED" });
    }
    client.close();
  });

  it("does not hide an unknown live row from the default view", async () => {
    const row = await rowFor(LIVE_NO_FACTS);
    // It is still a live process, so the operator must still see it.
    expect(selectDashboardSessions([row], { view: "live" })).toHaveLength(1);
  });

  it("keeps a state-filtered query honest about an unknown row", async () => {
    const row = await rowFor(LIVE_NO_FACTS);
    // A query asking for READY sessions must not collect one whose state was never reported.
    expect(selectDashboardSessions([row], { taskStates: ["READY"] })).toHaveLength(0);
  });
});

describe("2. queued work does not make a busy loop 'waiting'", () => {
  it("stays WORKING when the loop is known busy and work is also queued", () => {
    const state = rowStateFromStatus({ bridge: { facts: { agentPhase: "start", idle: false, pendingMessages: true } }, exit: null, reaped: null, owner: { pid: 1 }, attachments: [] });
    expect(state.taskState).toBe("WORKING");
    // The queue is still reported, just not as the state.
    expect(describeOwnerActivity(state)).toMatch(/queued/u);
  });

  it("reserves WAITING for a loop that is not running with work queued", () => {
    const state = rowStateFromStatus({ bridge: { facts: { agentPhase: "settled", idle: true, pendingMessages: true } }, exit: null, reaped: null, owner: { pid: 1 }, attachments: [] });
    expect(state.taskState).toBe("WAITING");
  });

  it("infers nothing about background idleness or tool approval", () => {
    const state = rowStateFromStatus({ bridge: { facts: { agentPhase: "settled", idle: true, pendingMessages: false } }, exit: null, reaped: null, owner: { pid: 1 }, attachments: [] });
    const summary = describeOwnerActivity(state);
    expect(summary).toMatch(/background work not reported/u);
    expect(summary).not.toMatch(/approval|tool waiting|nothing running/u);
    expect(state.backgroundWorkKnown).toBe(false);
  });
});

describe("4. a malformed listing is an error, not an empty catalogue", () => {
  it("raises on output that is not a catalogue at all", () => {
    expect(() => parseModelCatalogue("unexpected output, not a model table")).toThrow(/catalogue/iu);
    try {
      parseModelCatalogue("unexpected output, not a model table");
    } catch (error) {
      expect(error.code).toBe("MODEL_CATALOG_UNREADABLE");
      // Bounded and sanitized: the listing's own text is not dumped into the message.
      expect(error.message).not.toMatch(/unexpected output, not a model table/u);
      expect(error.message.length).toBeLessThan(400);
    }
  });

  it("does not leak private-looking stdout into the error", () => {
    const secret = "sk-live-0123456789abcdef /home/operator/.pi/credentials.json";
    try {
      parseModelCatalogue(`${secret}\nstill not a table`);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error.message).not.toMatch(/sk-live/u);
      expect(error.message).not.toMatch(/credentials/u);
      expect(error.message).not.toMatch(/\.pi\//u);
    }
  });

  it("treats Pi's own explicit empty answer as empty", () => {
    expect(parseModelCatalogue("No models available. Use /login to log into a provider via OAuth or API key.")).toEqual([]);
  });

  it("keeps parsing a valid table exactly as before", () => {
    const table = [
      "provider       model      context  max-out  thinking  images",
      "fixture-alpha  alpha-one  1K       100      no        no    ",
      "fixture-alpha  alpha-two  2K       200      yes       no    ",
    ].join("\n");
    expect(parseModelCatalogue(table)).toEqual([
      { provider: "fixture-alpha", id: "alpha-one", thinking: false },
      { provider: "fixture-alpha", id: "alpha-two", thinking: true },
    ]);
  });

  it("surfaces the unreadable catalogue through getModels rather than an empty picker", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-honesty-"));
    const client = createNativeBackend({ sessionsHome, listModels: async () => "garbage from a broken pi" });
    await expect(client.getModels()).rejects.toMatchObject({ code: "MODEL_CATALOG_UNREADABLE" });
    client.close();
  });
});
