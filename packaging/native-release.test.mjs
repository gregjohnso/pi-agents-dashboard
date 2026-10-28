import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename), lstat: vi.fn(actual.lstat) };
});
const actualFs = await vi.importActual("node:fs/promises");

import {
  assertNoEscapingSymlinks,
  inventoryRelease,
  replaceLauncher,
  rollbackLauncher,
  snapshotSymlink,
  writeReleaseReceipt,
} from "./native-release.mjs";

const roots = [];
afterEach(async ({ task }) => {
  vi.resetAllMocks();
  const completedRoots = roots.splice(0);
  if (task.result?.state === "fail") {
    console.error("Retained failed fixtures:", completedRoots);
    return;
  }
  await Promise.all(completedRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(process.env.NATIVE_RELEASE_TEST_ROOT ?? tmpdir(), "pi-agents-release-"));
  roots.push(root);
  const releaseRoot = path.join(root, "release with spaces");
  const candidate = path.join(releaseRoot, "bin", "pi-agents");
  const oldTarget = path.join(root, "old target");
  const launcherPath = path.join(root, "bin", "pi-agents");
  const releaseReceiptPath = path.join(root, "receipts", "release.json");
  const activationReceiptPath = path.join(root, "receipts", "activation.json");
  await Promise.all([
    mkdir(path.dirname(candidate), { recursive: true }),
    mkdir(path.dirname(launcherPath), { recursive: true }),
    mkdir(path.dirname(releaseReceiptPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(candidate, "#!/bin/sh\nexit 0\n", { mode: 0o750 }),
    writeFile(oldTarget, "old launcher target\n"),
  ]);
  await symlink("../old target", launcherPath);
  const inventory = await inventoryRelease(releaseRoot);
  await writeReleaseReceipt({ releaseRoot, releaseReceiptPath, inventory, releaseId: "fixture" });
  return { root, releaseRoot, candidate, oldTarget, launcherPath, releaseReceiptPath, activationReceiptPath, inventory };
}

it("rejects a dependency symlink that escapes its installed closure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agents-links-"));
  roots.push(root);
  const dependencies = path.join(root, "node_modules");
  await mkdir(path.join(dependencies, "package"), { recursive: true });
  await writeFile(path.join(dependencies, "package", "entry.mjs"), "export {};\n");
  await symlink("package/entry.mjs", path.join(dependencies, "inside"));
  await expect(assertNoEscapingSymlinks(dependencies)).resolves.toBeUndefined();

  await symlink("/development/cache/pi.js", path.join(dependencies, "outside"));
  await expect(assertNoEscapingSymlinks(dependencies)).rejects.toThrow(/escapes installed dependency root/u);
});

it("atomically replaces a matching fake launcher and restores its exact link text", async () => {
  const f = await fixture();
  const expectedOriginal = await snapshotSymlink(f.launcherPath);

  const receipt = await replaceLauncher({
    launcherPath: f.launcherPath,
    candidatePath: f.candidate,
    expectedOriginal,
    releaseRoot: f.releaseRoot,
    releaseReceiptPath: f.releaseReceiptPath,
    activationReceiptPath: f.activationReceiptPath,
  });
  expect(await readlink(f.launcherPath)).toBe(f.candidate);
  expect(receipt.original.linkText).toBe("../old target");

  await rollbackLauncher({ activationReceiptPath: f.activationReceiptPath });
  expect(await readlink(f.launcherPath)).toBe("../old target");
});

it("refuses a changed original link, changed release, and incomplete release", async () => {
  const changedLink = await fixture();
  const expectedOriginal = await snapshotSymlink(changedLink.launcherPath);
  await rm(changedLink.launcherPath);
  await symlink(changedLink.candidate, changedLink.launcherPath);
  await expect(replaceLauncher({
    launcherPath: changedLink.launcherPath,
    candidatePath: changedLink.candidate,
    expectedOriginal,
    releaseRoot: changedLink.releaseRoot,
    releaseReceiptPath: changedLink.releaseReceiptPath,
    activationReceiptPath: changedLink.activationReceiptPath,
  })).rejects.toThrow(/original launcher changed/u);

  const changedRelease = await fixture();
  await chmod(changedRelease.candidate, 0o750);
  await writeFile(changedRelease.candidate, "#!/bin/sh\nexit 9\n");
  await expect(replaceLauncher({
    launcherPath: changedRelease.launcherPath,
    candidatePath: changedRelease.candidate,
    expectedOriginal: await snapshotSymlink(changedRelease.launcherPath),
    releaseRoot: changedRelease.releaseRoot,
    releaseReceiptPath: changedRelease.releaseReceiptPath,
    activationReceiptPath: changedRelease.activationReceiptPath,
  })).rejects.toThrow(/release digest changed/u);

  const incomplete = await fixture();
  await writeFile(path.join(incomplete.releaseRoot, ".incomplete"), "incomplete\n");
  const refreshed = await inventoryRelease(incomplete.releaseRoot);
  await writeReleaseReceipt({ releaseRoot: incomplete.releaseRoot, releaseReceiptPath: incomplete.releaseReceiptPath, inventory: refreshed, releaseId: "fixture" });
  await expect(replaceLauncher({
    launcherPath: incomplete.launcherPath,
    candidatePath: incomplete.candidate,
    expectedOriginal: await snapshotSymlink(incomplete.launcherPath),
    releaseRoot: incomplete.releaseRoot,
    releaseReceiptPath: incomplete.releaseReceiptPath,
    activationReceiptPath: incomplete.activationReceiptPath,
  })).rejects.toThrow(/incomplete/u);
});

it("records the target checksum and identity needed for a guarded replacement", async () => {
  const f = await fixture();
  const snapshot = await snapshotSymlink(f.launcherPath);
  expect(snapshot).toMatchObject({
    linkText: "../old target",
    resolvedTarget: f.oldTarget,
    target: {
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      dev: expect.stringMatching(/^\d+$/u),
      ino: expect.stringMatching(/^\d+$/u),
    },
    link: {
      dev: expect.stringMatching(/^\d+$/u),
      ino: expect.stringMatching(/^\d+$/u),
      mode: expect.any(Number),
    },
  });
  const persisted = JSON.parse(await readFile(f.releaseReceiptPath, "utf8"));
  expect(persisted.releaseDigest).toBe(f.inventory.digest);
});

async function activate(f, expectedOriginal) {
  return replaceLauncher({ ...f, candidatePath: f.candidate, expectedOriginal });
}

async function substituteLink(f, linkText) {
  const replacement = path.join(path.dirname(f.launcherPath), "substitution");
  await symlink(linkText, replacement);
  await actualFs.rename(replacement, f.launcherPath);
  return snapshotSymlink(f.launcherPath);
}

it("refuses a launcher changed during release verification without overwriting it", async () => {
  const f = await fixture();
  const original = await snapshotSymlink(f.launcherPath);
  let substituted;
  vi.mocked(readFile).mockImplementation(async (...args) => {
    const bytes = await actualFs.readFile(...args);
    if (args[0] === f.candidate && !substituted) {
      substituted = await substituteLink(f, original.linkText);
    }
    return bytes;
  });
  await expect(activate(f, original)).rejects.toThrow(/original launcher changed/u);
  expect(await snapshotSymlink(f.launcherPath)).toEqual(substituted);
});

it("checks the original again after persisting PREPARED recovery evidence", async () => {
  const f = await fixture();
  const original = await snapshotSymlink(f.launcherPath);
  let substituted;
  vi.mocked(rename).mockImplementation(async (source, destination) => {
    await actualFs.rename(source, destination);
    if (destination === f.activationReceiptPath && !substituted) {
      substituted = await substituteLink(f, original.linkText);
    }
  });
  await expect(activate(f, original)).rejects.toThrow(/original launcher changed/u);
  expect(await snapshotSymlink(f.launcherPath)).toEqual(substituted);
});

it.each(["receipt", "snapshot"])("retains PREPARED evidence and guarded recovery after post-rename %s failure", async (failure) => {
  const f = await fixture();
  const original = await snapshotSymlink(f.launcherPath);
  let switched = false;
  vi.mocked(rename).mockImplementation(async (source, destination) => {
    if (switched && destination === f.activationReceiptPath && failure === "receipt") {
      throw new Error("injected final receipt failure");
    }
    await actualFs.rename(source, destination);
    if (destination === f.launcherPath) switched = true;
  });
  vi.mocked(lstat).mockImplementation(async (...args) => {
    if (switched && args[0] === f.launcherPath && failure === "snapshot") {
      throw new Error("injected installed snapshot failure");
    }
    return actualFs.lstat(...args);
  });
  const error = await activate(f, original).catch((caught) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ switched: true, activationReceiptPath: f.activationReceiptPath });
  vi.resetAllMocks();
  const prepared = JSON.parse(await readFile(f.activationReceiptPath, "utf8"));
  expect(prepared).toMatchObject({ state: "PREPARED", activated: false, original });
  expect(prepared.candidate).toEqual(await snapshotSymlink(f.launcherPath));
  expect(prepared.rollbackCommand).toBeUndefined();
  expect(prepared.rollback).toEqual({ api: "rollbackLauncher", activationReceiptPath: f.activationReceiptPath });
  const restored = await rollbackLauncher({ activationReceiptPath: f.activationReceiptPath });
  expect(restored.restored.target).toEqual(original.target);
  expect(restored.restored.linkText).toBe(original.linkText);
});

it("refuses PREPARED persistence failure without changing the launcher", async () => {
  const f = await fixture();
  const original = await snapshotSymlink(f.launcherPath);
  vi.mocked(rename).mockImplementation(async (source, destination) => {
    if (destination === f.activationReceiptPath) throw new Error("injected preparation failure");
    await actualFs.rename(source, destination);
  });
  await expect(activate(f, original)).rejects.toThrow(/injected preparation failure/u);
  expect(await snapshotSymlink(f.launcherPath)).toEqual(original);
});

it("refuses rollback of a same-text candidate with a different symlink inode", async () => {
  const f = await fixture();
  const receipt = await activate(f, await snapshotSymlink(f.launcherPath));
  const substituted = await substituteLink(f, receipt.candidate.linkText);
  expect(substituted.link.ino).not.toBe(receipt.candidate.link.ino);
  await expect(rollbackLauncher({ activationReceiptPath: f.activationReceiptPath })).rejects.toThrow(/rollback refused/u);
  expect(await snapshotSymlink(f.launcherPath)).toEqual(substituted);
});

it.each(["mode", "inode", "bytes"])("refuses rollback before mutation when old-target %s changed", async (field) => {
  const f = await fixture();
  const receipt = await activate(f, await snapshotSymlink(f.launcherPath));
  if (field === "mode") await chmod(f.oldTarget, 0o700);
  if (field === "bytes") await writeFile(f.oldTarget, "changed old target\n");
  if (field === "inode") {
    await writeFile(`${f.oldTarget}.new`, await readFile(f.oldTarget));
    await actualFs.rename(`${f.oldTarget}.new`, f.oldTarget);
  }
  await expect(rollbackLauncher({ activationReceiptPath: f.activationReceiptPath })).rejects.toThrow(/old launcher target changed; rollback refused/u);
  expect(await snapshotSymlink(f.launcherPath)).toEqual(receipt.candidate);
});

it.each(["mode", "uid", "gid", "size"])("compares the original target's recorded %s before activation", async (field) => {
  const f = await fixture();
  const original = await snapshotSymlink(f.launcherPath);
  const expected = structuredClone(original);
  expected.target[field] = typeof expected.target[field] === "number" ? expected.target[field] + 1 : "9999";
  await expect(activate(f, expected)).rejects.toThrow(/original launcher changed/u);
  expect(await snapshotSymlink(f.launcherPath)).toEqual(original);
});

it("compares the old target's actual mode before activation", async () => {
  const f = await fixture();
  const original = await snapshotSymlink(f.launcherPath);
  await chmod(f.oldTarget, 0o700);
  const changed = await snapshotSymlink(f.launcherPath);
  await expect(activate(f, original)).rejects.toThrow(/original launcher changed/u);
  expect(await snapshotSymlink(f.launcherPath)).toEqual(changed);
});
