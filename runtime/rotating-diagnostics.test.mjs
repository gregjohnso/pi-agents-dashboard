import { appendFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { openRotatingDiagnostics, openRotatingWriter } from "./rotating-diagnostics.mjs";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function root() {
  const path = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
  cleanup.push(path);
  return path;
}

/** @param {string} directory @param {string} prefix */
async function files(directory, prefix) {
  return (await readdir(directory)).filter((name) => name.startsWith(`${prefix}.`)).sort().map((name) => join(directory, name));
}

it("reopens complete crash-safe segments and retains private modes", async () => {
  const directory = await root();
  let writer = await openRotatingWriter({ directory, prefix: "rpc", segmentBytes: 512, segments: 2 });
  await writer.append({ id: "before" });
  await writer.close();
  await appendFile((await files(directory, "rpc"))[0], '{"id":"partial"');
  writer = await openRotatingWriter({ directory, prefix: "rpc", segmentBytes: 512, segments: 2 });
  await writer.append({ id: "after" });
  await writer.close();

  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  const paths = await files(directory, "rpc");
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) expect((await stat(path)).mode & 0o777).toBe(0o600);
  const text = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("");
  expect(text).toContain("before");
  expect(text).toContain("after");
  expect(text).not.toContain("partial");
});
