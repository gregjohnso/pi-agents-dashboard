import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PINNED_NODE_VERSION = "v22.23.2";
const PINNED_CLI_SHA256 = "e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774";
const PINNED_TREE = "b0c4f259cb287cecadbeecf1dc49aac56682462b";
const REQUIRED_APP_PATHS = [
  "bin/pi-agents.mjs",
  "cli/native-main.mjs",
  "examples/native-session-demo/manager-demo.mjs",
  "examples/native-session-demo/demo.mjs",
  "examples/native-session-demo/owner-preload.mjs",
  "examples/native-session-demo/owner-extension.ts",
  "extension/pi-agents-owner.mjs",
  "runtime/pty-mechanism.mjs",
  "vendor/pty/pi-agents-owner-pty-linux-x64-gnu.node",
  "vendor/pty/THIRD-PARTY-NOTICES.md",
  "vendor/pty/third-party-inventory.json",
];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function unsignedIdentity(value) {
  return BigInt.asUintN(64, value).toString();
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function walk(root, current = root, entries = []) {
  const names = await readdir(current);
  names.sort();
  for (const name of names) {
    const absolute = path.join(current, name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const metadata = await lstat(absolute);
    const common = { path: relative, mode: metadata.mode & 0o7777 };
    if (metadata.isDirectory()) {
      entries.push({ ...common, type: "directory" });
      await walk(root, absolute, entries);
    } else if (metadata.isSymbolicLink()) {
      entries.push({ ...common, type: "symlink", target: await readlink(absolute) });
    } else if (metadata.isFile()) {
      const bytes = await readFile(absolute);
      entries.push({ ...common, type: "file", bytes: bytes.length, sha256: digest(bytes) });
    } else {
      throw new Error(`unsupported release entry ${absolute}`);
    }
  }
  return entries;
}

export async function inventoryRelease(releaseRoot) {
  const root = await realpath(releaseRoot);
  const entries = await walk(root);
  return { root, entries, digest: digest(JSON.stringify(entries)) };
}

export async function assertNoEscapingSymlinks(dependencyRoot) {
  const root = await realpath(dependencyRoot);
  const entries = await walk(root);
  for (const entry of entries.filter((candidate) => candidate.type === "symlink")) {
    const link = path.join(root, entry.path);
    const lexicalTarget = path.resolve(path.dirname(link), entry.target);
    if (!within(root, lexicalTarget)) {
      throw new Error(`dependency symlink ${link} -> ${entry.target} escapes installed dependency root ${root}`);
    }
    let resolved;
    try {
      resolved = await realpath(link);
    } catch (error) {
      throw new Error(`dependency symlink ${link} is unresolved inside installed dependency root ${root}`, { cause: error });
    }
    if (!within(root, resolved)) {
      throw new Error(`dependency symlink ${link} resolves to ${resolved}, which escapes installed dependency root ${root}`);
    }
  }
}

async function atomicJson(destination, value) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export async function writeReleaseReceipt({ releaseRoot, releaseReceiptPath, inventory, releaseId, metadata = {} }) {
  const receipt = {
    schemaVersion: 1,
    releaseId,
    releaseRoot: await realpath(releaseRoot),
    releaseDigest: inventory.digest,
    inventoryEntries: inventory.entries.length,
    ...metadata,
  };
  await atomicJson(releaseReceiptPath, receipt);
  return receipt;
}

export async function verifyRelease({ releaseRoot, releaseReceiptPath }) {
  try {
    await access(path.join(releaseRoot, ".incomplete"));
    throw new Error(`release ${releaseRoot} is incomplete`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const receipt = JSON.parse(await readFile(releaseReceiptPath, "utf8"));
  const actualRoot = await realpath(releaseRoot);
  if (receipt.releaseRoot !== actualRoot) throw new Error(`release receipt names ${receipt.releaseRoot}, not ${actualRoot}`);
  const inventory = await inventoryRelease(actualRoot);
  if (inventory.digest !== receipt.releaseDigest) {
    throw new Error(`release digest changed: expected ${receipt.releaseDigest}, received ${inventory.digest}`);
  }
  return { receipt, inventory };
}

export async function snapshotSymlink(launcherPath) {
  const metadata = await lstat(launcherPath, { bigint: true });
  if (!metadata.isSymbolicLink()) throw new Error(`${launcherPath} is not a symbolic link`);
  const linkText = await readlink(launcherPath);
  const resolvedTarget = await realpath(launcherPath);
  const targetMetadata = await stat(resolvedTarget, { bigint: true });
  const target = {
    mode: Number(targetMetadata.mode & 0o7777n),
    uid: Number(targetMetadata.uid),
    gid: Number(targetMetadata.gid),
    dev: unsignedIdentity(targetMetadata.dev),
    ino: unsignedIdentity(targetMetadata.ino),
    size: targetMetadata.size.toString(),
    sha256: targetMetadata.isFile() ? digest(await readFile(resolvedTarget)) : null,
  };
  return {
    launcherPath: path.resolve(launcherPath),
    linkText,
    resolvedTarget,
    link: {
      mode: Number(metadata.mode & 0o7777n),
      uid: Number(metadata.uid),
      gid: Number(metadata.gid),
      dev: unsignedIdentity(metadata.dev),
      ino: unsignedIdentity(metadata.ino),
    },
    target,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function sameTarget(left, right) {
  return left.resolvedTarget === right.resolvedTarget
    && sameIdentity(left.target, right.target)
    && left.target.size === right.target.size
    && left.target.sha256 === right.target.sha256;
}

function sameOriginal(left, right) {
  return left.launcherPath === right.launcherPath
    && left.linkText === right.linkText
    && sameIdentity(left.link, right.link)
    && sameTarget(left, right);
}

async function prepareSymlink(linkText, destination) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  await symlink(linkText, temporary);
  return temporary;
}

/** Requires exclusive cooperating launcher/target/receipt writers through completion or recovery.
 * Rename is not compare-and-swap; uncooperative external writers are not excluded.
 */
export async function replaceLauncher({ launcherPath, candidatePath, expectedOriginal, releaseRoot, releaseReceiptPath, activationReceiptPath }) {
  const verified = await verifyRelease({ releaseRoot, releaseReceiptPath });
  const release = await realpath(releaseRoot);
  const candidate = await realpath(candidatePath);
  if (!within(release, candidate)) throw new Error(`candidate ${candidate} is outside release ${release}`);
  await access(candidate, constants.X_OK);
  const temporary = await prepareSymlink(candidate, launcherPath);
  let switched = false;
  try {
    const preparedCandidate = { ...await snapshotSymlink(temporary), launcherPath: path.resolve(launcherPath) };
    const prepared = {
      schemaVersion: 1,
      state: "PREPARED",
      activated: false,
      original: expectedOriginal,
      candidate: preparedCandidate,
      releaseRoot: release,
      releaseDigest: verified.inventory.digest,
      rollbackLinkText: expectedOriginal.linkText,
      rollback: { api: "rollbackLauncher", activationReceiptPath },
    };
    // PREPARED records intent, not the live state; recovery checks the candidate inode.
    await atomicJson(activationReceiptPath, prepared);
    const current = await snapshotSymlink(launcherPath);
    if (!sameOriginal(current, expectedOriginal)) throw new Error("original launcher changed; replacement refused");
    await rename(temporary, launcherPath);
    switched = true;
    const installed = await snapshotSymlink(launcherPath);
    if (!sameOriginal(installed, preparedCandidate)) throw new Error("installed launcher differs from prepared candidate");
    const receipt = { ...prepared, state: "ACTIVATED", activated: true, candidate: installed };
    await atomicJson(activationReceiptPath, receipt);
    return receipt;
  } catch (cause) {
    if (switched) {
      throw Object.assign(new Error("launcher switched; finalization failed; use guarded rollbackLauncher recovery", { cause }), {
        switched: true,
        activationReceiptPath,
      });
    }
    await rm(temporary, { force: true });
    throw cause;
  }
}

/** Requires the same exclusive-writer window as replaceLauncher, including recovery. */
export async function rollbackLauncher({ activationReceiptPath }) {
  const receipt = JSON.parse(await readFile(activationReceiptPath, "utf8"));
  const launcherPath = receipt.original.launcherPath;
  const temporary = await prepareSymlink(receipt.original.linkText, launcherPath);
  let switched = false;
  try {
    let preparedOriginal;
    try {
      preparedOriginal = await snapshotSymlink(temporary);
    } catch (cause) {
      throw new Error("old launcher target changed; rollback refused", { cause });
    }
    if (!sameTarget(preparedOriginal, receipt.original)) {
      throw new Error("old launcher target changed; rollback refused");
    }
    const current = await snapshotSymlink(launcherPath);
    if (!sameOriginal(current, receipt.candidate)) {
      throw new Error("current launcher does not match the activated candidate; rollback refused");
    }
    await rename(temporary, launcherPath);
    switched = true;
    const restored = await snapshotSymlink(launcherPath);
    if (!sameOriginal(restored, { ...preparedOriginal, launcherPath })) {
      throw new Error("rollback did not restore the prepared launcher");
    }
    return { ...receipt, rolledBack: true, restored };
  } catch (cause) {
    if (switched) {
      throw Object.assign(new Error("launcher switched to rollback link; verification failed", { cause }), {
        switched: true,
        activationReceiptPath,
      });
    }
    await rm(temporary, { force: true });
    throw cause;
  }
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 300_000,
  });
}

async function makeAppReadOnly(appRoot) {
  const entries = await walk(appRoot);
  for (const entry of entries.filter((candidate) => candidate.type !== "symlink").reverse()) {
    const absolute = path.join(appRoot, entry.path);
    if (entry.type === "directory") await chmod(absolute, 0o550);
    else await chmod(absolute, entry.mode & 0o111 ? 0o550 : 0o440);
  }
  await chmod(appRoot, 0o550);
}

/** Assemble the candidate directly at its final release path; no prefix-bound environment is moved afterward. */
export async function prepareCandidateRelease({
  sourceRoot,
  prefix,
  releaseId,
  cohortRoot,
  cohortManifestPath,
  pixiExecutable,
  npmExecutable,
  allowExistingPrefix = false,
}) {
  let prefixExists = false;
  try {
    const metadata = await lstat(prefix);
    if (!metadata.isDirectory()) throw new Error(`candidate prefix is not a directory: ${prefix}`);
    prefixExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (prefixExists && !allowExistingPrefix) throw new Error(`candidate prefix already exists: ${prefix}`);
  const releaseRoot = path.join(prefix, "releases", releaseId);
  try {
    await lstat(releaseRoot);
    throw new Error(`candidate release already exists: ${releaseRoot}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const appRoot = path.join(releaseRoot, "app");
  const nodeRuntimeRoot = path.join(releaseRoot, "runtime", "node");
  const receiptRoot = path.join(prefix, "receipts");
  const attemptRoot = path.join(prefix, "attempts", releaseId);
  await Promise.all([
    mkdir(appRoot, { recursive: true, mode: 0o750 }),
    mkdir(nodeRuntimeRoot, { recursive: true, mode: 0o750 }),
    mkdir(receiptRoot, { recursive: true, mode: 0o700 }),
    mkdir(attemptRoot, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(path.join(releaseRoot, ".incomplete"), "candidate preparation has not completed\n", { mode: 0o600 });

  const sourceNodeBin = path.dirname(path.resolve(npmExecutable));
  const commandEnv = {
    ...process.env,
    PATH: `${sourceNodeBin}:/usr/bin:/bin`,
    npm_config_audit: "false",
    npm_config_cache: path.join(attemptRoot, "npm-cache"),
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  const packed = JSON.parse((await run(npmExecutable, ["pack", "--json", "--pack-destination", attemptRoot], {
    cwd: sourceRoot,
    env: commandEnv,
  })).stdout);
  if (!Array.isArray(packed) || packed.length !== 1) throw new Error(`npm pack produced ${packed.length} artifacts`);
  const tarball = path.join(attemptRoot, packed[0].filename);
  // 15k files; measured at 466 s on a slow shared filesystem, past run()'s 300 s default.
  await run("tar", ["-xzf", tarball, "--strip-components=1", "-C", appRoot], { cwd: sourceRoot, timeout: 1_800_000 });
  await rm(path.join(appRoot, "node_modules"), { recursive: true, force: true });
  await cp(path.join(cohortRoot, "node_modules"), path.join(appRoot, "node_modules"), {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });

  await Promise.all(REQUIRED_APP_PATHS.map((relative) => access(path.join(appRoot, relative), constants.R_OK)));
  const sourceManifest = JSON.parse(await readFile(cohortManifestPath, "utf8"));
  if (sourceManifest.bundledCliSha256 !== PINNED_CLI_SHA256) throw new Error("cohort manifest names the wrong bundled CLI digest");
  if (sourceManifest.patchedTreeHash !== PINNED_TREE) throw new Error("cohort manifest names the wrong patched tree");
  const bundledCli = path.join(appRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  if (digest(await readFile(bundledCli)) !== PINNED_CLI_SHA256) throw new Error("copied bundled CLI digest mismatch");
  const packagedManifest = {
    ...sourceManifest,
    consumerRoot: "..",
    bundledCliPath: "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    tuiPackageRoot: "../node_modules/@earendil-works/pi-tui",
    sourceManifestPath: path.resolve(cohortManifestPath),
  };
  await writeFile(path.join(appRoot, "runtime", "cohort-manifest.json"), `${JSON.stringify(packagedManifest, null, 2)}\n`, { mode: 0o440 });
  await assertNoEscapingSymlinks(path.join(appRoot, "node_modules"));

  await Promise.all([
    cp(path.join(sourceRoot, "pixi.toml"), path.join(nodeRuntimeRoot, "pixi.toml")),
    cp(path.join(sourceRoot, "pixi.lock"), path.join(nodeRuntimeRoot, "pixi.lock")),
  ]);
  const pixiCache = path.join(prefix, "cache", "pixi");
  await run(pixiExecutable, ["install", "--frozen", "--manifest-path", path.join(nodeRuntimeRoot, "pixi.toml")], {
    cwd: nodeRuntimeRoot,
    env: { ...process.env, PIXI_CACHE_DIR: pixiCache },
    timeout: 600_000,
  });
  const pinnedNode = path.join(nodeRuntimeRoot, ".pixi", "envs", "default", "bin", "node");
  const nodeVersion = (await run(pinnedNode, ["--version"], { cwd: releaseRoot })).stdout.trim();
  if (nodeVersion !== PINNED_NODE_VERSION) throw new Error(`installed Node is ${nodeVersion}, not ${PINNED_NODE_VERSION}`);

  const launcher = path.join(releaseRoot, "bin", "pi-agents");
  await mkdir(path.dirname(launcher), { recursive: true, mode: 0o750 });
  await writeFile(
    launcher,
    `#!/bin/sh\nset -eu\nexec ${shellQuote(pinnedNode)} ${shellQuote(path.join(appRoot, "bin", "pi-agents.mjs"))} "$@"\n`,
    { mode: 0o550 },
  );
  await rm(path.join(releaseRoot, ".incomplete"));
  await makeAppReadOnly(appRoot);
  await chmod(launcher, 0o550);

  const inventory = await inventoryRelease(releaseRoot);
  const inventoryPath = path.join(receiptRoot, `${releaseId}.inventory.json`);
  await atomicJson(inventoryPath, inventory);
  const releaseReceiptPath = path.join(receiptRoot, `${releaseId}.json`);
  const receipt = await writeReleaseReceipt({
    releaseRoot,
    releaseReceiptPath,
    inventory,
    releaseId,
    metadata: {
      appTarball: tarball,
      appTarballSha256: digest(await readFile(tarball)),
      cohortSourceRoot: path.resolve(cohortRoot),
      cohortSourceManifest: path.resolve(cohortManifestPath),
      packagedCohortManifest: path.join(appRoot, "runtime", "cohort-manifest.json"),
      bundledCli,
      bundledCliSha256: PINNED_CLI_SHA256,
      patchedTreeHash: PINNED_TREE,
      node: pinnedNode,
      nodeVersion,
      launcher,
      inventoryPath,
      operationalDependencyPaths: [appRoot, path.join(appRoot, "node_modules"), pinnedNode, path.join(appRoot, "vendor", "pty")],
    },
  });
  return { prefix, releaseRoot, appRoot, launcher, inventory, inventoryPath, releaseReceiptPath, receipt };
}
