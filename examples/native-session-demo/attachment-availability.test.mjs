/**
 * Attachment availability is not task state.
 *
 * The operator hit this exactly: an old session's row said READY - which is true, its agent is alive and idle -
 * and opening it answered `ATTACH_PRESENTATION_UNSUPPORTED`. READY was never wrong; it was answering a different
 * question. So availability becomes its own additive fact on the row, and a live agent is never demoted to
 * FAILED/STOPPED just because this frontend cannot open it.
 *
 * Three states, kept apart on purpose:
 *   - `supported`   the manager positively advertises an attach protocol this list speaks;
 *   - `unavailable` this list actually tried and got a NAMED refusal from this same owner, or the manager
 *                   advertises a protocol this list does not speak;
 *   - `unreported`  nothing is known. Managers from the increment that shipped ATTACH_PROTOCOL 2 support it but
 *                   predate the status advertisement, so absence must never read as incompatible.
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ATTACH_PROTOCOL } from "./client.mjs";
import { createNativeBackend, describeOwnerActivity, rowStateFromStatus } from "../../app/list/native-backend.mjs";
import { displaySessionState } from "../../app/list/session-state.mjs";
import { destructiveAction } from "../../app/list/dashboard-overlays.mjs";
import { selectDashboardSessions } from "../../app/list/dashboard-state.mjs";

const LIVE_READY = {
  owner: { pid: 4242, startIdentity: "identity-a" },
  attachments: [],
  exit: null,
  reaped: null,
  bridge: { connected: true, facts: { agentPhase: "settled", idle: true, pendingMessages: false } },
};

/** The same owner, plus the advertisement a current manager publishes. */
const LIVE_READY_ADVERTISED = { ...LIVE_READY, attach: { protocol: ATTACH_PROTOCOL } };

describe("an unopenable session keeps its real task state and says so on the row", () => {
  it("stays LIVE and READY while the row visibly says the attachment is unavailable", () => {
    const state = rowStateFromStatus(LIVE_READY, {
      attachment: { state: "unavailable", code: "ATTACH_PRESENTATION_UNSUPPORTED", reason: "this manager is older than this list and confirms no screen repaint." },
    });
    // The agent is alive and idle. That has not changed and must not be rewritten.
    expect(state.processState).toBe("LIVE");
    expect(state.taskState).toBe("READY");
    expect(state.taskState).not.toBe("FAILED");
    expect(state.taskState).not.toBe("STOPPED");
    const row = { ...state, stateReported: state.stateIsKnown, activity: { kind: "native", summary: describeOwnerActivity(state) } };
    expect(displaySessionState(row)).toBe("READY");
    // And the operator can see it without clicking: the row's own summary leads with it.
    expect(row.activity.summary).toMatch(/attachment unavailable \(older manager\)/u);
    expect(row.activity.summary.indexOf("attachment unavailable")).toBe(0);
  });

  it("says nothing extra when the manager positively advertises a protocol this list speaks", () => {
    const state = rowStateFromStatus(LIVE_READY_ADVERTISED, { attachment: { state: "supported", protocol: ATTACH_PROTOCOL } });
    expect(describeOwnerActivity(state)).not.toMatch(/attachment unavailable/u);
  });

  it("says nothing extra when nothing is known, because absence is not incompatibility", () => {
    const state = rowStateFromStatus(LIVE_READY, { attachment: { state: "unreported" } });
    expect(describeOwnerActivity(state)).not.toMatch(/attachment unavailable/u);
    // A record with no availability metadata at all renders exactly as it did before.
    expect(describeOwnerActivity(rowStateFromStatus(LIVE_READY, {}))).not.toMatch(/attachment/u);
  });

  it("leaves the row's actions and its place in the list alone", () => {
    const state = rowStateFromStatus(LIVE_READY, { attachment: { state: "unavailable", code: "ATTACH_PRESENTATION_UNSUPPORTED", reason: "older" } });
    const row = { ...state, sessionId: "s", revision: 1, stateReported: true, activity: { kind: "native", summary: describeOwnerActivity(state) } };
    // Stop still applies to a live owner, and the row stays in the default live view.
    expect(destructiveAction(row)).toBe("stop");
    expect(selectDashboardSessions([row], { view: "live" })).toHaveLength(1);
  });
});

describe("the backend decides availability from advertisement and its own refusals", () => {
  async function backendWith(statusFor) {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "pia-avail-"));
    await mkdir(path.join(sessionsHome, "session-1789000000001"), { recursive: true });
    const client = createNativeBackend({
      sessionsHome,
      listModels: async () => "provider  model",
      askControl: async () => ({ reachable: true, answer: { status: statusFor() } }),
    });
    return { client, sessionId: "session-1789000000001" };
  }

  const summaryOf = async (client) => (await client.getState()).sessions[0].activity.summary;
  const rowOf = async (client) => (await client.getState()).sessions[0];

  it("labels a peer only after it has actually refused, and keeps the label across refreshes", async () => {
    let status = LIVE_READY;
    const { client, sessionId } = await backendWith(() => status);
    // Before any attempt nothing is known, so nothing is claimed.
    expect(await summaryOf(client)).not.toMatch(/attachment unavailable/u);

    client.noteAttachRefusal(sessionId, {
      code: "ATTACH_PRESENTATION_UNSUPPORTED",
      reason: "this manager is older than this list and confirms no screen repaint. The session is still running.",
    });

    const labelled = await rowOf(client);
    expect(labelled.activity.summary).toMatch(/attachment unavailable \(older manager\)/u);
    expect(labelled.taskState).toBe("READY");
    expect(labelled.processState).toBe("LIVE");
    // The actionable reason is still carried for the detail surface.
    expect(labelled.attachment).toMatchObject({ state: "unavailable", code: "ATTACH_PRESENTATION_UNSUPPORTED" });
    expect(labelled.attachment.reason).toMatch(/still running/u);
    // Ordinary row refresh must not wash it away while the owner is the same.
    expect(await summaryOf(client)).toMatch(/attachment unavailable/u);
    expect(await summaryOf(client)).toMatch(/attachment unavailable/u);
    client.close();
  });

  it("does not inherit a previous owner's refusal when the identity changes", async () => {
    let status = LIVE_READY;
    const { client, sessionId } = await backendWith(() => status);
    client.noteAttachRefusal(sessionId, { code: "ATTACH_PRESENTATION_UNSUPPORTED", reason: "older" });
    expect(await summaryOf(client)).toMatch(/attachment unavailable/u);

    // A different owner behind the same directory is a different peer, so the old observation is stale.
    status = { ...LIVE_READY, owner: { pid: 9999, startIdentity: "identity-b" } };
    expect(await summaryOf(client)).not.toMatch(/attachment unavailable/u);
    client.close();
  });

  it("clears the label when the manager positively advertises support", async () => {
    let status = LIVE_READY;
    const { client, sessionId } = await backendWith(() => status);
    client.noteAttachRefusal(sessionId, { code: "ATTACH_PRESENTATION_UNSUPPORTED", reason: "older" });
    expect(await summaryOf(client)).toMatch(/attachment unavailable/u);

    status = LIVE_READY_ADVERTISED;
    const row = await rowOf(client);
    expect(row.activity.summary).not.toMatch(/attachment unavailable/u);
    expect(row.attachment).toMatchObject({ state: "supported", protocol: ATTACH_PROTOCOL });
    client.close();
  });

  it("marks a manager that advertises a protocol this list cannot speak", async () => {
    const status = { ...LIVE_READY, attach: { protocol: ATTACH_PROTOCOL + 99 } };
    const { client } = await backendWith(() => status);
    const row = await rowOf(client);
    expect(row.attachment.state).toBe("unavailable");
    expect(row.activity.summary).toMatch(/attachment unavailable/u);
    // Still a live, ready agent.
    expect(row.taskState).toBe("READY");
    client.close();
  });

  it("ignores a refusal that is not about attach compatibility", async () => {
    const { client, sessionId } = await backendWith(() => LIVE_READY);
    client.noteAttachRefusal(sessionId, { code: "ATTACH_FAILED", reason: "native attachment ended with code 1" });
    expect(await summaryOf(client)).not.toMatch(/attachment unavailable/u);
    client.close();
  });
});
