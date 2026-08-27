import * as fs from "node:fs/promises";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

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

it("publishes complete JSON through a mode-0600 temporary file in the target directory", async () => {
  const { directory, target } = await makeTarget("state.json");
  /** @type {Array<{ path: string, flags: unknown, mode: unknown }>} */
  const opened = [];
  const fsOps = {
    ...fs,
    /** @param {string} path @param {any} flags @param {any} mode */
    async open(path, flags, mode) {
      opened.push({ path, flags, mode });
      return fs.open(path, flags, mode);
    },
  };

  await atomicWriteJson(target, { ready: true }, fsOps);

  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ ready: true });
  expect((await readFile(target, "utf8")).endsWith("\n")).toBe(true);
  expect(opened[0]).toMatchObject({ flags: "wx", mode: 0o600 });
  expect(dirname(opened[0].path)).toBe(directory);
  expect(basename(opened[0].path)).toMatch(/^\.state\.json\..+\.tmp$/);
  expect(await readdir(directory)).toEqual(["state.json"]);
});

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

it.each([
  [
    "a torn temporary write before rename",
    () => ({
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
    }),
    "torn write",
    { old: true },
  ],
  [
    "a failed rename",
    () => ({ ...fs, rename: async () => { throw new Error("rename failed"); } }),
    "rename failed",
    { old: true },
  ],
  [
    "a directory fsync failure after rename",
    () => {
      let openCount = 0;
      return {
        ...fs,
        /** @param {string} path @param {any} flags @param {any} mode */
        async open(path, flags, mode) {
          openCount += 1;
          const handle = await fs.open(path, flags, mode);
          if (openCount === 2) {
            return {
              async sync() {
                throw new Error("directory fsync failed");
              },
              close: () => handle.close(),
            };
          }
          return handle;
        },
      };
    },
    "directory fsync failed",
    { ready: true },
  ],
])("reports %s and leaves one complete file behind", async (_label, makeFsOps, message, contents) => {
  const { directory, target } = await makeTarget("state.json");

  await expect(atomicWriteJson(target, { ready: true }, makeFsOps())).rejects.toThrow(message);

  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(contents);
  expect(await readdir(directory)).toEqual(["state.json"]);
});

it("rejects values JSON cannot serialize before touching the filesystem", async () => {
  const { target } = await makeTarget("state.json");
  const fsOps = { ...fs, open: async () => { throw new Error("must not open"); } };

  await expect(atomicWriteJson(target, 1n, fsOps)).rejects.toThrow(/serializable/i);
  expect(await readFile(target, "utf8")).toBe('{"old":true}\n');
});
