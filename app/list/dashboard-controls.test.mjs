import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

import { DashboardController } from "./dashboard.mjs";
import { createHelpOverlay } from "./dashboard-overlays.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const at = "2026-10-26T00:00:00Z";
  const client = { getState: async () => ({ sessions: [{ sessionId: "one", revision: 1, name: "one", cwd: "/repo/one", processState: "LIVE", taskState: "READY", outcome: "NONE", activity: { kind: "assistant_final", summary: "one", updatedAt: at }, createdAt: at, updatedAt: at }], cursor: { daemonEpoch: "test", sequence: "1" } }),
    subscribeListChanges: async () => () => {}, refreshSummaries: vi.fn(async () => {}) };
  const dashboard = new DashboardController({ client, clientId: "two-controls", openViewer: async () => {}, requestRender: () => {}, launchDefaults: { cwd: "/repo" } });
  cleanup.push(() => dashboard.close());
  await dashboard.open();
  return { dashboard, client };
}

function select(dashboard, category) {
  expect(dashboard.controlCategory).toBeTypeOf("string");
  let remaining = 20;
  while (dashboard.controlCategory !== category && remaining-- > 0) dashboard.handleInput("\x16");
  expect(dashboard.controlCategory).toBe(category);
}

it("Ctrl+V chooses a category without changing filters or the draft", async () => {
  const { dashboard } = await fixture();
  dashboard.setComposerPrompt("keep this draft");
  const before = structuredClone(dashboard.query);
  expect(dashboard.controlCategory).toBe("view");
  dashboard.handleInput("\x16");
  expect(dashboard.controlCategory).toBe("task");
  expect(dashboard.query).toEqual(before);
  expect(dashboard.composerDraft.prompt).toBe("keep this draft");
  expect(dashboard.render(100, 24).map(stripVTControlCharacters).join("\n")).toContain("ctrl+t: task");
});

it("Ctrl+T cycles the selected view's values", async () => {
  const { dashboard } = await fixture();
  dashboard.handleInput("\x14");
  expect(dashboard.query.view).toBe("done");
  dashboard.handleInput("\x14");
  expect(dashboard.query.view).toBe("all");
  dashboard.handleInput("\x14");
  expect(dashboard.query.view).toBe("live");
});

it.each([
  ["task", { taskStates: ["WORKING"] }],
  ["process", { processStates: ["LIVE"] }],
  ["outcome", { outcomes: ["NONE"] }],
  ["activity", { activityKinds: ["assistant_final"] }],
  ["project", { projectPaths: ["/repo/one"] }],
  ["sort", { sort: { key: "age", direction: "asc" } }],
  ["group", { groupBy: "taskState" }],
])("uses the same two keys for %s", async (category, expected) => {
  const { dashboard } = await fixture();
  select(dashboard, category);
  dashboard.handleInput("\x14");
  expect(dashboard.query).toMatchObject(expected);
});

it("keeps clear, refresh and metadata available through the same pair", async () => {
  const { dashboard, client } = await fixture();
  dashboard.setTaskStates(["WORKING"]);
  select(dashboard, "clear filters");
  dashboard.handleInput("\x14");
  expect(dashboard.query.taskStates).toBeUndefined();
  select(dashboard, "refresh");
  dashboard.handleInput("\x14");
  expect(client.refreshSummaries).toHaveBeenCalledTimes(1);
  select(dashboard, "metadata");
  dashboard.handleInput("\x14");
  expect(dashboard.overlay?.kind).toBe("metadata");
  dashboard.handleInput("\x16");
  expect(dashboard.overlay).toBeUndefined();
  expect(dashboard.controlCategory).toBe("view");
});

it("retires the old filter chords without inserting control bytes or changing query state", async () => {
  const { dashboard, client } = await fixture();
  dashboard.setTaskStates(["READY"]);
  dashboard.setComposerPrompt("draft");
  const before = structuredClone(dashboard.query);
  // Ctrl+S is not among them: it is Claude Code's state/directory grouping switch, tested on its own.
  for (const key of ["\x10", "\x0f", "\x01", "\x17", "\x02", "\x0c", "\x12", "\x05"]) dashboard.handleInput(key);
  expect(dashboard.query).toEqual(before);
  expect(dashboard.composerDraft.prompt).toBe("draft");
  expect(dashboard.overlay).toBeUndefined();
  expect(client.refreshSummaries).not.toHaveBeenCalled();
});

it("shows only the consolidated pair rather than the old shortcut matrix in help", () => {
  const bindings = createHelpOverlay().bindings;
  expect(bindings.find((binding) => binding.keys === "Ctrl+V / Ctrl+T")).toBeDefined();
  expect(bindings.some((binding) => /Ctrl\+[POAWBLRE]/u.test(binding.keys))).toBe(false);
  // The one grouping key, matching Claude Code's agent view.
  expect(bindings.filter((binding) => binding.keys.startsWith("Ctrl+S"))).toEqual([{ keys: "Ctrl+S", action: "group by state or by working directory" }]);
});
