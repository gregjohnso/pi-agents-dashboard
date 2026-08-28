import * as fs from "node:fs/promises";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { atomicWriteJson } from "./atomic-file.mjs";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** @param {string} name */
async function makeTarget(name) {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-atomic-"));
  cleanup.push(directory);
  const target = join(directory, name);
  await writeFile(target, '{"old":true}\n');
  return { directory, target };
}

it("publishes an exact mode-0600 file under a restrictive inherited umask", async () => {
  const { target } = await makeTarget("state.json");
  const previousUmask = process.umask(0o777);
  try {
    await atomicWriteJson(target, { ready: true });
  } finally {
    process.umask(previousUmask);
  }

  expect((await lstat(target)).mode & 0o777).toBe(0o600);
});

it("reports a torn temporary write and leaves one complete file behind", async () => {
  const { directory, target } = await makeTarget("state.json");
  const fsOps = {
    ...fs,
    /** @param {string} path @param {any} flags @param {any} mode */
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      return {
        /** @param {number} mode */
        chmod: (mode) => handle.chmod(mode),
        stat: () => handle.stat(),
        /** @param {unknown} data */
        async writeFile(data) {
          await handle.writeFile(String(data).slice(0, 4));
          throw new Error("torn write");
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  };

  await expect(atomicWriteJson(target, { ready: true }, fsOps)).rejects.toThrow("torn write");

  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ old: true });
  expect(await readdir(directory)).toEqual(["state.json"]);
});
