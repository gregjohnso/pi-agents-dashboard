import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it } from "vitest";

import { DashboardController } from "./dashboard.mjs";

const AT = "2026-10-26T00:00:00Z";
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const row = (sessionId, cwd) => ({ sessionId, revision: 1, name: sessionId, cwd, processState: "LIVE", taskState: "READY", outcome: "NONE",
  activity: { kind: "native", summary: sessionId, updatedAt: AT }, createdAt: AT, updatedAt: AT });

async function fixture() {
  const launched = [];
  const client = {
    getState: async () => ({ sessions: [row("alpha", "/repo/alpha"), row("beta", "/repo/beta")], cursor: { daemonEpoch: "test", sequence: "1" } }),
    subscribeListChanges: async () => () => {},
    preflightLaunch: async (draft) => ({ isolationMode: draft.isolationMode, canonicalCwd: draft.cwd, ownerSessionIds: [] }),
    launch: async (request) => { launched.push(request); return { sessionId: `session-${launched.length}` }; },
  };
  const dashboard = new DashboardController({ client, clientId: "follow-cwd", openViewer: async () => {}, requestRender: () => {},
    launchDefaults: { cwd: "/home/me" }, isDirectory: async () => true, worktreeCapability: async () => ({ available: false }) });
  cleanup.push(() => dashboard.close());
  await dashboard.open();
  const header = () => stripVTControlCharacters(dashboard.render(120, 30).slice(0, 3).join("\n"));
  return { dashboard, launched, header };
}

it("shows and launches in the directory of the session under the cursor", async () => {
  const { dashboard, launched, header } = await fixture();
  dashboard.selectSession("beta");
  expect(header()).toContain("cwd: /repo/beta");
  dashboard.setComposerPrompt("new task");
  await dashboard.submitComposer();
  expect(launched.at(-1).cwd).toBe("/repo/beta");
  dashboard.moveSelection(-1);
  expect(header()).toContain("cwd: /repo/alpha");
});

it("an explicit /cwd wins until the cursor moves", async () => {
  const { dashboard, launched, header } = await fixture();
  dashboard.selectSession("alpha");
  dashboard.setComposerPrompt("/cwd /elsewhere");
  await dashboard.runListCommand();
  expect(header()).toContain("cwd: /elsewhere");
  dashboard.setComposerPrompt("task there");
  await dashboard.submitComposer();
  expect(launched.at(-1).cwd).toBe("/elsewhere");
  dashboard.moveSelection(1);
  expect(header()).toContain("cwd: /repo/beta");
});
