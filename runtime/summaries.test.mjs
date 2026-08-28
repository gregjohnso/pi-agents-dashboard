import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { openSettingsStore, summarizePromptInput, summarizeWithPi } from "./summaries.mjs";

/** @type {string[]} */
const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function directory() {
  const created = await mkdtemp(join(tmpdir(), "dashboard-summaries-"));
  directories.push(created);
  return created;
}

/** @param {{ stdout?: string, code?: number, failSpawn?: boolean }} behavior */
function fakePi(behavior) {
  /** @type {any[]} */
  const calls = [];
  const spawnImpl = (/** @type {string} */ command, /** @type {string[]} */ argv, /** @type {any} */ options) => {
    calls.push({ command, argv, options });
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => {
      if (behavior.failSpawn === true) { child.emit("error", new Error("spawn failed")); return; }
      if (behavior.stdout !== undefined) child.stdout.emit("data", Buffer.from(behavior.stdout));
      child.emit("exit", behavior.code ?? 0, null);
    });
    return child;
  };
  return { spawnImpl, calls };
}

it("persists the opt-in summary model and defaults to disabled", async () => {
  const root = await directory();
  const store = await openSettingsStore({ directory: root });
  expect(store.current()).toEqual({ summaryModel: null });

  await store.setSummaryModel({ provider: "anthropic", id: "haiku" });
  expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toMatchObject({ schemaVersion: 1, summaryModel: { provider: "anthropic", id: "haiku" } });
  expect((await openSettingsStore({ directory: root })).current()).toEqual({ summaryModel: { provider: "anthropic", id: "haiku" } });

  await store.setSummaryModel(null);
  expect((await openSettingsStore({ directory: root })).current()).toEqual({ summaryModel: null });
});

it("builds a bounded transcript excerpt from normalized items", () => {
  const transcript = summarizePromptInput([
    { kind: "user_message", itemId: "u", content: [{ type: "text", text: "fix   the loader" }] },
    { kind: "tool", itemId: "tool:t", toolId: "t" },
    { kind: "assistant_message", itemId: "a", content: [{ type: "thinking", text: "private" }, { type: "text", text: "loader fixed" }] },
  ]);
  expect(transcript).toBe("User: fix the loader\nTool: t\nAssistant: loader fixed");
  expect(summarizePromptInput([])).toBe("");
});

it("reads a title and summary from one model reply", async () => {
  const pi = fakePi({ stdout: "Title: Coverage loader fix\nSummary: Fixes the coverage loader and reruns tests\n" });
  await expect(summarizeWithPi({ executable: "/installed/pi", model: { provider: "anthropic", id: "haiku" }, transcript: "User: hi", spawnImpl: pi.spawnImpl, env: {} }))
    .resolves.toEqual({ name: "Coverage loader fix", text: "Fixes the coverage loader and reruns tests" });
});

it("summarizes through stock Pi print mode without a session or tools, keeping an untitled reply", async () => {
  const pi = fakePi({ stdout: "  Fixes the coverage loader and reruns tests\n" });
  const summary = await summarizeWithPi({ executable: "/installed/pi", model: { provider: "anthropic", id: "haiku" }, transcript: "User: hi", spawnImpl: pi.spawnImpl, env: {} });
  expect(summary).toEqual({ name: undefined, text: "Fixes the coverage loader and reruns tests" });
  expect(pi.calls[0].argv.slice(0, 8)).toEqual(["--print", "--no-session", "--no-tools", "--provider", "anthropic", "--model", "haiku", "--"]);
  expect(pi.calls[0].options).toMatchObject({ shell: false });
});

it.each([
  ["a spawn failure", { failSpawn: true }],
  ["empty output", { stdout: "   " }],
])("returns no summary for %s", async (_label, behavior) => {
  const pi = fakePi(behavior);
  await expect(summarizeWithPi({ executable: "/installed/pi", model: { provider: "anthropic", id: "haiku" }, transcript: "User: hi", spawnImpl: pi.spawnImpl, env: {} })).resolves.toBeUndefined();
});

it("never spawns Pi for an empty transcript", async () => {
  const pi = fakePi({ stdout: "unused" });
  await expect(summarizeWithPi({ executable: "/installed/pi", model: { provider: "anthropic", id: "haiku" }, transcript: "  ", spawnImpl: pi.spawnImpl, env: {} })).resolves.toBeUndefined();
  expect(pi.calls).toEqual([]);
});
