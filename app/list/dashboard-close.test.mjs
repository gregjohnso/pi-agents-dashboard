import { afterEach, expect, it, vi } from "vitest";

import { DashboardController } from "./dashboard.mjs";
import { createSessionConfirmation } from "./dashboard-overlays.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function row(id, stopped = false) {
  return { schemaVersion: 1, revision: 1, sessionId: id, name: id, sessionFile: `/pi/${id}.jsonl`, canonicalSessionFile: `/pi/${id}.jsonl`, cwd: "/repo", processState: stopped ? "EXITED" : "LIVE", taskState: stopped ? "STOPPED" : "READY", stateReported: true, outcome: "NONE", activity: { kind: "native", summary: id, updatedAt: "2026-10-24T00:00:00.000Z" }, createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z" };
}

async function fixture() {
  let clock = 1000;
  const original = [row("one"), row("two")];
  const client = {
    getState: vi.fn(async () => ({ sessions: original, cursor: { daemonEpoch: "native", sequence: "2" } })),
    subscribeListChanges: async () => () => {},
    refreshSummaries: async () => {},
    stop: vi.fn(async () => ({ observedExit: true, session: row("one", true) })),
    delete: vi.fn(async () => ({ deleted: true })),
  };
  const dashboard = new DashboardController({ client, openViewer: async () => {}, clientId: "test", requestRender: vi.fn(), now: () => clock, launchDefaults: { cwd: "/repo" } });
  cleanup.push(() => dashboard.close());
  await dashboard.open();
  dashboard.setView("all");
  dashboard.selectSession("one");
  return { dashboard, client, original, advance: (milliseconds) => { clock += milliseconds; } };
}

it("updates a confirmed stopped row before list refresh and clears it without sending another stop", async () => {
  const f = await fixture();
  f.dashboard.setComposerPrompt("my unsent draft");
  await f.dashboard.confirmSession(createSessionConfirmation(f.original[0]));
  expect(f.dashboard.sessions.find((entry) => entry.sessionId === "one")).toMatchObject({ processState: "EXITED", taskState: "STOPPED" });
  expect(f.dashboard.status).toEqual({ kind: "ready" });
  expect(f.dashboard.composerDraft.prompt).toBe("my unsent draft");
  f.advance(501);
  f.dashboard.pressStopClear();
  f.dashboard.pressStopClear();
  await vi.waitFor(() => expect(f.client.delete).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(f.dashboard.sessions.some((entry) => entry.sessionId === "one")).toBe(false));
  expect(f.client.stop).toHaveBeenCalledTimes(1);
  expect(f.dashboard.composerDraft.prompt).toBe("my unsent draft");
  expect(f.dashboard.sessions.find((entry) => entry.sessionId === "two").processState).toBe("LIVE");
});

it("does not claim a process exited from a mere stop acceptance receipt", async () => {
  const f = await fixture();
  f.client.stop.mockResolvedValue({ accepted: true });
  await f.dashboard.confirmSession(createSessionConfirmation(f.original[0]));
  expect(f.dashboard.sessions[0].processState).toBe("LIVE");
});

it("updates only the stopped session when the user navigates while the stop is pending", async () => {
  const f = await fixture();
  let release;
  f.client.stop.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const pending = f.dashboard.confirmSession(createSessionConfirmation(f.original[0]));
  f.dashboard.moveSelection(1);
  release({ observedExit: true, session: row("one", true) });
  await pending;
  expect(f.dashboard.sessions.find((entry) => entry.sessionId === "one").processState).toBe("EXITED");
  expect(f.dashboard.sessions.find((entry) => entry.sessionId === "two").processState).toBe("LIVE");
  expect(f.dashboard.selectedSessionId).toBe("two");
  expect(f.dashboard.stopClearArmed).toBe(false);
});
