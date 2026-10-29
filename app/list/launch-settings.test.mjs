import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { readLaunchSettings } from "./launch-settings.mjs";

const cleanup = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function home(settings) {
  const directory = await mkdtemp(path.join(tmpdir(), "pia-launch-"));
  cleanup.push(directory);
  if (settings !== undefined) await writeFile(path.join(directory, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  return directory;
}

it("reads the default model a new session starts with", async () => {
  expect(await readLaunchSettings(await home({ version: 1, defaultModel: "openai-codex/gpt-6.1-sol" })))
    .toEqual({ model: { provider: "openai-codex", id: "gpt-6.1-sol" } });
});

it("keeps everything after the first slash as the model id", async () => {
  expect(await readLaunchSettings(await home({ version: 1, defaultModel: "openrouter/moonshotai/kimi-k3" })))
    .toEqual({ model: { provider: "openrouter", id: "moonshotai/kimi-k3" } });
});

it("leaves the model to Pi when nothing usable is set", async () => {
  for (const settings of [undefined, "{not json", { version: 2, defaultModel: "a/b" }, { version: 1 }, { version: 1, defaultModel: "no-slash" }, { version: 1, defaultModel: "/id" }, { version: 1, defaultModel: "provider/" }]) {
    expect(await readLaunchSettings(await home(settings))).toEqual({ model: undefined });
  }
});
