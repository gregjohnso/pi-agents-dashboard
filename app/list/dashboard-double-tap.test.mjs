import { afterEach, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";

import { DashboardController } from "./dashboard.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function row(id, stopped = false, revision = 1) {
  return { schemaVersion: 1, revision, sessionId: id, name: id, sessionFile: `/pi/${id}.jsonl`, canonicalSessionFile: `/pi/${id}.jsonl`, cwd: "/repo", processState: stopped ? "EXITED" : "LIVE", taskState: stopped ? "STOPPED" : "READY", outcome: "NONE", activity: { kind: "native", summary: id, updatedAt: "2026-10-25T00:00:00Z" }, createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z" };
}

async function fixture(stopped = false) {
  let clock = 1000;
  const client = {
    getState: async () => ({ sessions: [row("one", stopped), row("two")], cursor: { daemonEpoch: "native", sequence: "2" } }),
    subscribeListChanges: async () => () => {}, refreshSummaries: async () => {},
    stop: vi.fn(async (id) => ({ observedExit: true, session: row(id, true) })),
    delete: vi.fn(async () => ({ deleted: true })),
  };
  const dashboard = new DashboardController({ client, openViewer: async () => {}, clientId: "double-tap", requestRender: () => {}, now: () => clock, launchDefaults: { cwd: "/repo" } });
  cleanup.push(() => dashboard.close());
  await dashboard.open();
  dashboard.setView("all");
  dashboard.selectSession("one");
  return { client, dashboard, tap: () => dashboard.handleInput("\x18"), advance: (ms) => { clock += ms; } };
}

it("a single stop key only arms a hint and leaves the session and draft alone", async () => {
  const f = await fixture();
  f.dashboard.setComposerPrompt("keep my draft");
  f.tap();
  expect(f.client.stop).not.toHaveBeenCalled();
  expect(f.client.delete).not.toHaveBeenCalled();
  expect(f.dashboard.composerDraft.prompt).toBe("keep my draft");
  expect(f.dashboard.render(100, 24).map(stripVTControlCharacters).join("\n")).toContain("ctrl+x again to stop one");
});

it("a second tap at 500 ms stops once, then clearing needs a separate double-tap", async () => {
  const f = await fixture();
  f.tap();
  expect(f.client.stop).not.toHaveBeenCalled();
  f.advance(500);
  f.tap();
  await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(f.dashboard.sessions[0].processState).toBe("EXITED"));
  expect(f.dashboard.stopClearArmed).toBe(false);
  f.tap();
  expect(f.client.delete).not.toHaveBeenCalled();
  f.tap();
  await vi.waitFor(() => expect(f.client.delete).toHaveBeenCalledTimes(1));
  expect(f.client.stop).toHaveBeenCalledTimes(1);
});

it("a tap after 501 ms rearms rather than stopping", async () => {
  const f = await fixture();
  f.tap();
  f.advance(501);
  f.tap();
  expect(f.client.stop).not.toHaveBeenCalled();
  f.advance(20);
  f.tap();
  await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledTimes(1));
});

it("navigation and typing cancel the first tap rather than authorizing a different target", async () => {
  const f = await fixture();
  f.tap();
  f.dashboard.moveSelection(1);
  f.tap();
  expect(f.client.stop).not.toHaveBeenCalled();
  f.dashboard.handleInput("z");
  f.tap();
  expect(f.client.stop).not.toHaveBeenCalled();
  f.tap();
  await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledWith("two", 1, expect.any(String)));
  expect(f.client.stop).toHaveBeenCalledTimes(1);
});

it("a same-action metadata refresh preserves the first tap and uses the latest revision", async () => {
  const f = await fixture();
  f.tap();
  f.dashboard.applySnapshot({ sessions: [row("one", false, 2), row("two")] });
  expect(f.dashboard.stopClearArmed).toBe(true);
  expect(f.client.stop).not.toHaveBeenCalled();
  f.tap();
  await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledWith("one", 2, expect.any(String)));
});

it.each([false, true])("changing whether a row is stopped cancels its armed action (initial stopped=%s)", async (stopped) => {
  const f = await fixture(stopped);
  f.tap();
  f.dashboard.applySnapshot({ sessions: [row("one", !stopped), row("two")] });
  expect(f.dashboard.stopClearArmed).toBe(false);
  f.tap();
  expect(f.client.stop).not.toHaveBeenCalled();
  expect(f.client.delete).not.toHaveBeenCalled();
});

it("extra taps while the confirmed stop is pending cannot stop twice or clear", async () => {
  const f = await fixture();
  let release;
  f.client.stop.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  f.tap();
  expect(f.client.stop).not.toHaveBeenCalled();
  f.tap();
  f.tap();
  f.tap();
  expect(f.client.stop).toHaveBeenCalledTimes(1);
  expect(f.client.delete).not.toHaveBeenCalled();
  release({ observedExit: true, session: row("one", true) });
  await vi.waitFor(() => expect(f.dashboard.status.kind).toBe("ready"));
  expect(f.dashboard.stopClearArmed).toBe(false);
});
