import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const DRIVER = "perf/cold-launch.mjs";
const LAUNCHER = "perf/cold_launch_launcher.py";
const SKIPPED = new Set(["node_modules", ".git", ".pixi", ".worktrees", "docs"]);

/** Every file vitest collects, relative to the repository root. @param {string} directory */
async function collectedTestFiles(directory = REPOSITORY) {
  /** @type {string[]} */
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await collectedTestFiles(path));
    else if (/\.test\.(mjs|ts)$/u.test(entry.name)) found.push(path);
  }
  return found;
}

it("ships a cold-launch measurement driver and its SLURM launcher", async () => {
  expect((await stat(join(REPOSITORY, DRIVER))).isFile()).toBe(true);
  expect((await stat(join(REPOSITORY, LAUNCHER))).isFile()).toBe(true);
});

it("keeps the driver out of every file vitest collects, so the suite never runs model inference", async () => {
  const importers = [];
  for (const path of await collectedTestFiles()) {
    if ((await readFile(path, "utf8")).includes("cold-launch.mjs")) importers.push(path.slice(REPOSITORY.length));
  }
  expect(importers).toEqual(["perf/cold-launch.test.mjs"]);
  expect(await readFile(join(REPOSITORY, DRIVER), "utf8")).not.toContain("import.meta.vitest");
});

it("keeps the measurement out of the published package", async () => {
  const manifest = JSON.parse(await readFile(join(REPOSITORY, "package.json"), "utf8"));
  expect(manifest.files.some((/** @type {string} */ pattern) => pattern.startsWith("perf"))).toBe(false);
  expect(Object.values(manifest.scripts).some((/** @type {any} */ script) => String(script).includes("cold-launch"))).toBe(false);
});
