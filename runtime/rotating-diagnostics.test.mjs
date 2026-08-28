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

it("records a bounded truncation marker when rollover removes the oldest complete segment", async () => {
  const directory = await root();
  const writer = await openRotatingWriter({ directory, prefix: "rpc", segmentBytes: 300, segments: 2 });
  for (const record of [1, 2, 3, 4, 5, 6].map((id) => ({ id, payload: "x".repeat(100) }))) await writer.append(record);
  await writer.close();

  const paths = await files(directory, "rpc");
  expect(paths).toHaveLength(2);
  const records = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("").trim().split("\n").map((line) => JSON.parse(line));
  const marker = records.find((record) => record.type === "diagnostic_truncation");
  expect(marker.removedBytes).toBeGreaterThan(0);
  expect(marker.removedRecords).toBeGreaterThan(0);
  expect((await Promise.all(paths.map((path) => stat(path)))).every((metadata) => metadata.size <= 300)).toBe(true);
});

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

it("keeps default raw RPC and stderr diagnostics within schema-2 byte limits", async () => {
  const directory = await root();
  const diagnostics = await openRotatingDiagnostics({ directory });
  await diagnostics.rpc.append("r".repeat(8_388_608));
  await diagnostics.stderr.append("e".repeat(8_388_608));
  await diagnostics.close();
  const rpcBytes = (await Promise.all((await files(directory, "rpc")).map(async (path) => (await stat(path)).size))).reduce((a, b) => a + b, 0);
  const stderrBytes = (await Promise.all((await files(directory, "stderr")).map(async (path) => (await stat(path)).size))).reduce((a, b) => a + b, 0);
  expect(rpcBytes).toBeLessThanOrEqual(33_554_432);
  expect(stderrBytes).toBeLessThanOrEqual(8_388_608);
});
