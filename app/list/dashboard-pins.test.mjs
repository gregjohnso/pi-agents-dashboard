import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { DashboardController } from "./dashboard.mjs";
import { readPins, writePins } from "./view-preferences.mjs";

const AT = "2026-10-26T00:00:00Z";
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const row = (sessionId, taskState, cwd, ownerId) => ({ sessionId, revision: 1, name: sessionId, cwd, processState: "LIVE", taskState, outcome: "NONE",
  activity: { kind: "native", summary: sessionId, updatedAt: AT }, createdAt: AT, updatedAt: AT, ...(ownerId === undefined ? {} : { durable: { ownerId } }) });
const SESSIONS = [row("busy", "WORKING", "/repo/a", "owner-busy"), row("idle", "READY", "/repo/b", "owner-idle")];

async function fixture(options = {}) {
  const changes = [];
  const client = { getState: async () => ({ sessions: SESSIONS, cursor: { daemonEpoch: "test", sequence: "1" } }), subscribeListChanges: async () => () => {} };
  const dashboard = new DashboardController({ client, clientId: "pins", openViewer: async () => {}, requestRender: () => {}, launchDefaults: { cwd: "/repo" },
    initialGroupBy: "taskState", onPinsChanged: (pins) => changes.push(pins), ...options });
  cleanup.push(() => dashboard.close());
  await dashboard.open();
  /** Group labels and session ids in screen order. */
  const order = () => dashboard.list.rows.filter((entry) => entry.kind !== "gap").map((entry) => entry.kind === "group" ? `[${entry.label}]` : entry.session.sessionId);
  return { dashboard, changes, order };
}

it("Ctrl+T pins the selected session into a PINNED group at the top, and again unpins it", async () => {
  const { dashboard, changes, order } = await fixture();
  expect(order()).toEqual(["[WORKING]", "busy", "[READY]", "idle"]);
  dashboard.selectSession("idle");
  dashboard.handleInput("\x14");
  expect(order()).toEqual(["[PINNED]", "idle", "[WORKING]", "busy"]);
  expect(dashboard.selectedSessionId).toBe("idle");
  expect(changes.at(-1)).toEqual(["owner-idle"]);
  dashboard.handleInput("\x14");
  expect(order()).toEqual(["[WORKING]", "busy", "[READY]", "idle"]);
  expect(changes.at(-1)).toEqual([]);
});

it("keeps pinned sessions on top when grouped by directory", async () => {
  const { dashboard, order } = await fixture({ initialGroupBy: "cwd", initialPins: ["owner-idle"] });
  expect(order()).toEqual(["[PINNED]", "idle", "[/repo/a]", "busy"]);
});

it("restores pins saved by an earlier dashboard", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pia-pins-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  expect(await readPins(dir)).toEqual([]);
  await writePins(dir, ["owner-busy"]);
  const { order } = await fixture({ initialPins: await readPins(dir) });
  expect(order()).toEqual(["[PINNED]", "busy", "[READY]", "idle"]);
});
