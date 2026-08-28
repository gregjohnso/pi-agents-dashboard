import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createModelCatalog, parseModelCatalog } from "./pi-model-catalog.mjs";

const OUTPUT = [
  "provider         model                                context  max-out  thinking  images",
  "anthropic        claude-opus-5                        1M       128K     yes       yes",
  "openai-codex     gpt-5.6-sol                          400K     128K     yes       no",
  "google           gemma-3-4b-it                        128K     8.2K     no        no",
].join("\n");

/** @param {string} output @param {{ code?: number }} [options] */
function fakePi(output, { code = 0 } = {}) {
  return vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    setImmediate(() => { child.stdout.emit("data", output); child.emit("exit", code); });
    return child;
  });
}

describe("Pi model catalog", () => {
  it("reads the providers and models Pi will accept", () => {
    expect(parseModelCatalog(OUTPUT)).toEqual([
      { provider: "anthropic", id: "claude-opus-5", thinking: true },
      { provider: "openai-codex", id: "gpt-5.6-sol", thinking: true },
      { provider: "google", id: "gemma-3-4b-it", thinking: false },
    ]);
  });

  it("asks Pi once and serves the cache after that", async () => {
    const spawn = fakePi(OUTPUT);
    const catalog = createModelCatalog({ executable: "/usr/bin/pi", spawn });
    expect(await catalog.models()).toHaveLength(3);
    expect(await catalog.models()).toHaveLength(3);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(/** @type {any} */ (spawn.mock.calls[0])[1]).toEqual(["--list-models"]);
  });

  it("reports a failed listing and retries on the next request", async () => {
    const spawn = fakePi("", { code: 1 });
    const catalog = createModelCatalog({ executable: "/usr/bin/pi", spawn });
    await expect(catalog.models()).rejects.toMatchObject({ code: "MODEL_CATALOG_FAILED" });
    await expect(catalog.models()).rejects.toMatchObject({ code: "MODEL_CATALOG_FAILED" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
