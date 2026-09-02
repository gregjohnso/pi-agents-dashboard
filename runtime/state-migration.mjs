import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { convertLegacyDashboardConfig } from "../shared/config.mjs";
import { validateSessionRecord } from "./registry-store.mjs";
import { validateWorkerReplayRecord } from "./worker-replay-contract.mjs";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MANIFEST = "migration-manifest.json";
const CANONICAL_MARKER = "CANONICAL";
const LEGACY_MARKER = "MIGRATED";
const LOCK = ".migration.lock";
const RECONCILIATION_MARKER = ".reconciliation-started";
/**
 * Durable formats this release deleted. A legacy root still holds them, so migration recognizes each
 * one and carries none of them forward. Their content is never parsed, because nothing will read it
 * again, and refusing the root over a format nobody reads would leave the operator unable to migrate.
 */
const DROPPED_LEGACY_ARTIFACTS = [
  /^queue\/commands\.jsonl$/u,
  /^daemon\/launch-results\.json$/u,
  /^cli\/pending\/[^/]+\.json$/u,
  /^index\/.+$/u,
  /^frontend-state\.json$/u,
  /^daemon\/attachment-results\.jsonl$/u,
  /^daemon\/event-acks\.json$/u,
];

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function migrationError(code, message, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
/** @param {string} directory @param {any} fsOps */
async function syncDirectory(directory, fsOps) { const handle = await fsOps.open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } }
/** @param {string} path @param {string|Buffer} value @param {any} fsOps */
async function durableFile(path, value, fsOps) {
  const handle = await fsOps.open(path, "wx", FILE_MODE);
  try { await handle.chmod(FILE_MODE); await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}
/** @param {string} value */
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
/** @param {any} value @param {readonly string[]} keys @param {string} label */
function exactObject(value, keys, label) { if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError(`${label} is invalid`); }
/** @param {any} value */
function validIdentity(value) { return Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value.startIdentity === "string" && value.startIdentity.length > 0 && Number.isSafeInteger(value.processGroupId) && value.processGroupId > 0; }
/** @param {string} text @param {(value:any)=>boolean} validate @param {string} label */
function validateJsonLines(text, validate, label) {
  if (text.length > 0 && !text.endsWith("\n")) throw new TypeError(`${label} has an incomplete record`);
  const values = text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
  if (!values.every(validate)) throw new TypeError(`${label} is invalid`);
  return values;
}
/** @param {string} relative @param {string} text */
function validateLegacyArtifact(relative, text) {
  if (DROPPED_LEGACY_ARTIFACTS.some((pattern) => pattern.test(relative))) return;
  try {
    if (relative === "dashboard.json") { convertLegacyDashboardConfig(JSON.parse(text)); return; }
    if (/^sessions\/[^/]+\.json$/u.test(relative)) { const record = validateSessionRecord(JSON.parse(text)); if (`sessions/${record.sessionId}.json` !== relative) throw new TypeError("Registry filename and session ID differ"); return; }
    if (relative === "daemon/control.token") { const token = text.trim(); if (token.length === 0 || token.length > 4096 || /\s/u.test(token)) throw new TypeError("Control token is invalid"); return; }
    if (relative === "daemon/workers.json") {
      const metadata = JSON.parse(text); exactObject(metadata, ["schemaVersion", "workers"], "Worker metadata"); if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.workers)) throw new TypeError("Worker metadata is invalid");
      // A run is reserved before its worker is spawned, so both identities are absent together until the launch binds them.
      for (const worker of metadata.workers) { exactObject(worker, ["sessionId", "runId", "leaseId", "generation", "identity", "piChildIdentity", "token", "proto", "cliVersion", "routeGeneration", "pendingRespawn"], "Worker record"); const bound = worker.identity !== undefined || worker.piChildIdentity !== undefined; if ([worker.sessionId, worker.runId, worker.leaseId].some((entry) => typeof entry !== "string" || entry.length === 0) || !Number.isSafeInteger(worker.generation) || worker.generation <= 0 || (bound && (!validIdentity(worker.identity) || !validIdentity(worker.piChildIdentity))) || (worker.token !== undefined && (typeof worker.token !== "string" || worker.token.length === 0)) || ![worker.proto, worker.routeGeneration].every((entry) => entry === undefined || (Number.isSafeInteger(entry) && entry > 0)) || (worker.pendingRespawn !== undefined && worker.pendingRespawn !== "upgrade") || (worker.cliVersion !== undefined && (typeof worker.cliVersion !== "string" || worker.cliVersion.length === 0))) throw new TypeError("Worker record is invalid"); }
      return;
    }
    if (relative === "daemon/pid.json") {
      const publication = JSON.parse(text); exactObject(publication, ["schemaVersion", "pid", "startIdentity", "processGroupId", "daemonEpoch", "tokenPath", "startedAt", "state", "error"], "Daemon publication");
      if (publication.schemaVersion !== 1 || !validIdentity(publication) || typeof publication.daemonEpoch !== "string" || typeof publication.tokenPath !== "string" || typeof publication.startedAt !== "string" || !["STARTING", "RECONCILING", "READY", "FAILED"].includes(publication.state)) throw new TypeError("Daemon publication is invalid");
      return;
    }
    if (relative === "daemon/reconciliation.json") { const value = JSON.parse(text); exactObject(value, ["schemaVersion", "daemonEpoch", "completedAt", "conflicts"], "Reconciliation record"); if (value.schemaVersion !== 1 || typeof value.daemonEpoch !== "string" || typeof value.completedAt !== "string" || !Array.isArray(value.conflicts)) throw new TypeError("Reconciliation record is invalid"); return; }
    if (relative === "cli/client-id") { const clientId = text.trim(); if (clientId.length === 0 || clientId.includes("/") || clientId.includes("\0") || clientId !== text.trim()) throw new TypeError("CLI identity is invalid"); return; }
    if (/^runs\/[^/]+\/(worker\.stdout\.log|worker\.stderr\.log)$/u.test(relative)) return;
    if (/^runs\/[^/]+\/worker-replay\.jsonl$/u.test(relative)) { validateJsonLines(text, validateWorkerReplayRecord, "Worker replay store"); return; }
    throw new TypeError(`Unknown legacy state artifact: ${relative}`);
  } catch (error) { throw migrationError("MALFORMED_LEGACY_STATE", `Malformed legacy artifact: ${relative}`, { cause: error }); }
}

/** @param {string} root @param {number} expectedUserId @param {any} fsOps */
async function inspectTree(root, expectedUserId, fsOps) {
  const rootRealpath = await fsOps.realpath(root);
  const rootMetadata = await fsOps.lstat(root);
  if (rootRealpath !== root || !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || rootMetadata.uid !== expectedUserId || (rootMetadata.mode & 0o777) !== DIRECTORY_MODE) throw migrationError("UNSAFE_LEGACY_STATE", `Legacy root is not a canonical private directory: ${root}`);
  /** @type {Array<{relative:string,type:"directory"|"file",text?:string}>} */
  const entries = [];
  /** @param {string} directory @param {string} relative */
  async function visit(directory, relative) {
    for (const name of (await fsOps.readdir(directory)).sort()) {
      if (relative === "" && [LOCK, LEGACY_MARKER].includes(name)) continue;
      const path = join(directory, name); const childRelative = relative === "" ? name : join(relative, name); const metadata = await fsOps.lstat(path);
      if (metadata.isSymbolicLink() || metadata.uid !== expectedUserId) throw migrationError("UNSAFE_LEGACY_STATE", `Unsafe legacy artifact: ${path}`);
      if (metadata.isDirectory()) {
        if ((metadata.mode & 0o777) !== DIRECTORY_MODE || await fsOps.realpath(path) !== path) throw migrationError("UNSAFE_LEGACY_STATE", `Unsafe legacy directory: ${path}`);
        entries.push({ relative: childRelative, type: "directory" }); await visit(path, childRelative);
      } else if (metadata.isFile()) {
        if ((metadata.mode & 0o777) !== FILE_MODE) throw migrationError("UNSAFE_LEGACY_STATE", `Unsafe legacy file mode: ${path}`);
        const handle = await fsOps.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        let text;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.uid !== expectedUserId || (opened.mode & 0o777) !== FILE_MODE || opened.dev !== metadata.dev || opened.ino !== metadata.ino) throw migrationError("UNSAFE_LEGACY_STATE", `Legacy file identity changed: ${path}`);
          text = await handle.readFile("utf8");
          const completed = await handle.stat();
          if (completed.dev !== opened.dev || completed.ino !== opened.ino || completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs) throw migrationError("UNSAFE_LEGACY_STATE", `Legacy file changed while read: ${path}`);
        } finally { await handle.close(); }
        validateLegacyArtifact(childRelative, text);
        entries.push({ relative: childRelative, type: "file", text });
      } else throw migrationError("UNSAFE_LEGACY_STATE", `Unsupported legacy artifact: ${path}`);
    }
  }
  await visit(root, "");
  const identity = digest(JSON.stringify({ root: rootRealpath, dev: rootMetadata.dev, ino: rootMetadata.ino, entries: entries.map((entry) => [entry.relative, entry.type, entry.text === undefined ? undefined : digest(entry.text)]) }));
  return { identity, entries };
}

/** @param {string} path @param {any} fsOps */
async function maybeManifest(path, fsOps) {
  try { return JSON.parse(await fsOps.readFile(path, "utf8")); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined; throw migrationError("MIGRATION_IDENTITY_MISMATCH", "Destination migration manifest is malformed", { cause: error }); }
}
/** @param {string} root @param {Array<{relative:string,sha256:string}>} files @param {number} expectedUserId @param {any} fsOps */
async function validatePublishedDestination(root, files, expectedUserId, fsOps) {
  await validateReconciledDestination(root, files, fsOps);
  for (const file of files) {
    const metadata = await fsOps.lstat(join(root, file.relative)).catch(() => undefined);
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== expectedUserId || (metadata.mode & 0o777) !== FILE_MODE) throw migrationError("MIGRATION_IDENTITY_MISMATCH", `Published migration artifact is unsafe: ${file.relative}`);
  }
}
/** @param {string} root @param {Array<{relative:string,sha256:string}>} files @param {any} fsOps */
async function validateReconciledDestination(root, files, fsOps) {
  // `frontend-state.json` and `queue/` are retired: nothing reads or writes either. A destination
  // root an earlier release wrote still holds them, and refusing to migrate into that root would be
  // a false collision.
  const allowed = new Set([LOCK, MANIFEST, CANONICAL_MARKER, RECONCILIATION_MARKER, "daemon", "sessions", "queue", "runs", "index", "cli", "frontend-state.json", "dashboard.json", ...files.map((file) => file.relative.split("/")[0])]);
  const collision = (await fsOps.readdir(root)).find((/** @type {string} */ name) => !allowed.has(name));
  if (collision !== undefined) throw migrationError("DESTINATION_COLLISION", `Destination contains unexpected artifact: ${collision}`);
}
/** @param {string} path @param {any} metadata @param {number} expectedUserId @param {any} fsOps */
async function readPrivateDestinationFile(path, metadata, expectedUserId, fsOps) {
  const handle = await fsOps.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== expectedUserId || (opened.mode & 0o777) !== FILE_MODE || opened.dev !== metadata.dev || opened.ino !== metadata.ino) throw migrationError("MIGRATION_IDENTITY_MISMATCH", `Migrated file is unsafe: ${path}`);
    const text = await handle.readFile("utf8");
    const completed = await handle.stat();
    if (completed.dev !== opened.dev || completed.ino !== opened.ino || completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs) throw migrationError("MIGRATION_IDENTITY_MISMATCH", `Migrated file changed while read: ${path}`);
    return text;
  } finally { await handle.close(); }
}
/** @param {string} root @param {Array<{relative:string,type:"directory"|"file",text?:string}>} entries @param {number} expectedUserId @param {any} fsOps */
async function validateCompletedDestination(root, entries, expectedUserId, fsOps) {
  const expected = new Map(entries.map((entry) => [entry.relative, entry]));
  const seen = new Set();
  /** @param {string} directory @param {string} relative */
  async function visit(directory, relative) {
    for (const name of await fsOps.readdir(directory)) {
      const path = join(directory, name);
      const child = relative === "" ? name : join(relative, name);
      const metadata = await fsOps.lstat(path);
      if (relative === "" && name === LOCK) {
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUserId || (metadata.mode & 0o777) !== DIRECTORY_MODE) throw migrationError("DESTINATION_COLLISION", "Migration lock is unsafe");
        continue;
      }
      if (relative === "" && name === MANIFEST) {
        try { await readPrivateDestinationFile(path, metadata, expectedUserId, fsOps); }
        catch (error) { if (/** @type {any} */ (error)?.code === "MIGRATION_IDENTITY_MISMATCH") throw error; throw migrationError("MIGRATION_IDENTITY_MISMATCH", "Migration manifest is unsafe", { cause: error }); }
        continue;
      }
      const entry = expected.get(child);
      if (entry === undefined || metadata.isSymbolicLink() || metadata.uid !== expectedUserId) throw migrationError("DESTINATION_COLLISION", `Unexpected interrupted migration artifact: ${child}`);
      if (entry.type === "directory") {
        if (!metadata.isDirectory() || (metadata.mode & 0o777) !== DIRECTORY_MODE) throw migrationError("DESTINATION_COLLISION", `Interrupted migration directory is unsafe: ${child}`);
        seen.add(child);
        await visit(path, child);
        continue;
      }
      if (!metadata.isFile()) throw migrationError("DESTINATION_COLLISION", `Interrupted migration artifact has the wrong type: ${child}`);
      let text;
      try { text = await readPrivateDestinationFile(path, metadata, expectedUserId, fsOps); }
      catch (error) { if (/** @type {any} */ (error)?.code === "MIGRATION_IDENTITY_MISMATCH") throw error; throw migrationError("MIGRATION_IDENTITY_MISMATCH", `Migrated file is unsafe: ${child}`, { cause: error }); }
      if (digest(text) !== digest(entry.text ?? "")) throw migrationError("MIGRATION_IDENTITY_MISMATCH", `Migrated file identity changed: ${child}`);
      seen.add(child);
    }
  }
  await visit(root, "");
  if (seen.size !== expected.size) throw migrationError("DESTINATION_COLLISION", "Interrupted migration output is incomplete");
}
/** @param {string} root @param {any} fsOps @param {boolean} create @param {number} expectedUserId */
async function acquireLock(root, fsOps, create, expectedUserId) {
  if (create) {
    let created = false;
    try { await fsOps.lstat(root); }
    catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error; await fsOps.mkdir(root, { recursive: true, mode: DIRECTORY_MODE }); await fsOps.chmod(root, DIRECTORY_MODE); created = true; }
    const metadata = await fsOps.lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUserId || (metadata.mode & 0o777) !== DIRECTORY_MODE) {
      if (created) await fsOps.rm(root, { recursive: true, force: true });
      throw migrationError("UNSAFE_DESTINATION_STATE", `Destination root is not a private directory: ${root}`);
    }
  }
  const path = join(root, LOCK);
  try { await fsOps.mkdir(path, { mode: DIRECTORY_MODE }); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") throw migrationError("MIGRATION_LOCKED", `Migration lock is held: ${path}`); throw error; }
  return async () => fsOps.rm(path, { recursive: true, force: true });
}
/** @param {string} root @param {Array<{relative:string,sha256:string}>} files @param {boolean} complete @param {any} fsOps */
async function validateRecoveryFiles(root, files, complete, fsOps) {
  const expected = new Map(files.map((file) => [file.relative, file.sha256]));
  const seen = new Set();
  /** @param {string} directory @param {string} relative */
  async function visit(directory, relative) {
    for (const name of await fsOps.readdir(directory)) {
      if (relative === "" && name === LOCK) continue;
      const path = join(directory, name); const child = relative === "" ? name : join(relative, name); const metadata = await fsOps.lstat(path);
      if (metadata.isSymbolicLink()) throw migrationError("DESTINATION_COLLISION", `Unsafe interrupted migration artifact: ${child}`);
      if (metadata.isDirectory()) await visit(path, child);
      else if (metadata.isFile() && expected.get(child) === digest(await fsOps.readFile(path, "utf8"))) seen.add(child);
      else throw migrationError("DESTINATION_COLLISION", `Interrupted migration artifact changed: ${child}`);
    }
  }
  await visit(root, "");
  if (complete && seen.size !== expected.size) throw migrationError("DESTINATION_COLLISION", "Interrupted migration output is incomplete");
}

/** @param {string} path @param {unknown} value @param {any} fsOps */
async function replaceJson(path, value, fsOps) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await durableFile(temporary, `${JSON.stringify(value, null, 2)}\n`, fsOps); await fsOps.rename(temporary, path); await syncDirectory(dirname(path), fsOps);
}

/**
 * Atomically migrate private legacy dashboard metadata to the standalone root.
 * @param {{legacyRoot:string,destinationRoot:string,expectedUserId:number,inspectLegacyRuntime:()=>Promise<any>,reconcileDestination:(context:{root:string,migrationId:string,manifest:any})=>Promise<any>,fsOps?:any,failpoint?:(stage:string)=>Promise<void>}} options
 */
export async function migrateLegacyState({ legacyRoot, destinationRoot, expectedUserId, inspectLegacyRuntime, reconcileDestination, fsOps = fs, failpoint = async () => {} }) {
  if (![legacyRoot, destinationRoot].every((root) => typeof root === "string" && resolve(root) === root) || legacyRoot === destinationRoot) throw new TypeError("Migration roots must be distinct absolute canonical paths");
  if (!Number.isSafeInteger(expectedUserId) || expectedUserId < 0) throw new TypeError("expectedUserId must be a non-negative integer");
  if (typeof inspectLegacyRuntime !== "function" || typeof reconcileDestination !== "function" || typeof failpoint !== "function") throw new TypeError("Migration seams must be functions");
  const releases = [];
  try {
    for (const root of [legacyRoot, destinationRoot].sort()) releases.push(await acquireLock(root, fsOps, root === destinationRoot, expectedUserId));
    const runtime = await inspectLegacyRuntime();
    if (runtime?.activeDaemon || (Array.isArray(runtime?.activeSupervisors) && runtime.activeSupervisors.length > 0)) throw migrationError("LEGACY_RUNTIME_ACTIVE", "Verified legacy daemon or supervisor is active", { identities: runtime });
    const tree = await inspectTree(legacyRoot, expectedUserId, fsOps);
    const destinationMetadata = await fsOps.lstat(destinationRoot);
    const destinationIdentity = digest(JSON.stringify({ realpath: await fsOps.realpath(destinationRoot), dev: destinationMetadata.dev, ino: destinationMetadata.ino }));
    const migrationId = digest(JSON.stringify([tree.identity, destinationIdentity, 1, 2]));
    const manifestPath = join(destinationRoot, MANIFEST);
    const retainedFiles = tree.entries.filter((entry) => entry.type === "file" && !DROPPED_LEGACY_ARTIFACTS.some((pattern) => pattern.test(entry.relative)));
    const preparedEntries = tree.entries.filter((entry) => {
      if (entry.type === "file") return retainedFiles.includes(entry);
      if (/^(index|queue)(?:\/|$)/u.test(entry.relative) || /^cli\/pending(?:\/|$)/u.test(entry.relative)) return false;
      if (["cli", "daemon"].includes(entry.relative)) return retainedFiles.some((file) => file.relative.startsWith(`${entry.relative}/`));
      return true;
    }).map((entry) => {
      if (entry.type !== "file") return entry;
      let text = entry.text ?? "";
      if (entry.relative === "dashboard.json") { try { text = `${JSON.stringify(convertLegacyDashboardConfig(JSON.parse(text)), null, 2)}\n`; } catch (error) { throw migrationError("MALFORMED_LEGACY_STATE", "Legacy dashboard configuration is invalid", { cause: error }); } }
      return { ...entry, text };
    });
    const files = preparedEntries.filter((entry) => entry.type === "file").map((entry) => ({ relative: entry.relative, type: "file", sha256: digest(entry.text ?? "") }));
    const existing = await maybeManifest(manifestPath, fsOps);
    let published = existing;
    if (existing !== undefined) {
      if (existing.migrationId !== migrationId || existing.sourceIdentity !== tree.identity) throw migrationError("MIGRATION_IDENTITY_MISMATCH", "Destination manifest belongs to another migration");
      const manifestKeys = ["schemaVersion", "migrationId", "sourceIdentity", "destinationIdentity", "state", "configFrom", "configTo", "createdAt", "updatedAt"];
      if (existing.schemaVersion !== 1 || existing.destinationIdentity !== destinationIdentity || existing.configFrom !== 1 || existing.configTo !== 2 || !["PREPARED", "PUBLISHED", "RECONCILED"].includes(existing.state) || typeof existing.createdAt !== "string" || typeof existing.updatedAt !== "string" || Object.keys(existing).length !== manifestKeys.length || Object.keys(existing).some((key) => !manifestKeys.includes(key))) throw migrationError("MIGRATION_IDENTITY_MISMATCH", "Destination manifest contract is invalid");
      if (existing.state === "RECONCILED" && await fsOps.readFile(join(destinationRoot, CANONICAL_MARKER), "utf8").then((/** @type {string} */ value) => value.trim() === migrationId).catch(() => false)) { await validateReconciledDestination(destinationRoot, files, fsOps); return { status: "ALREADY_MIGRATED", migrationId, manifestPath }; }
      if (existing.state === "PREPARED") await validateCompletedDestination(destinationRoot, preparedEntries, expectedUserId, fsOps);
      if (existing.state === "PUBLISHED") {
        const marker = await fsOps.readFile(join(destinationRoot, RECONCILIATION_MARKER), "utf8").then((/** @type {string} */ value) => value.trim()).catch((/** @type {NodeJS.ErrnoException} */ error) => { if (error.code === "ENOENT") return undefined; throw error; });
        if (marker !== undefined && marker !== migrationId) throw migrationError("MIGRATION_IDENTITY_MISMATCH", "Reconciliation marker belongs to another migration");
        if (marker === migrationId) await validatePublishedDestination(destinationRoot, files, expectedUserId, fsOps);
        else await validateCompletedDestination(destinationRoot, preparedEntries, expectedUserId, fsOps);
      }
    } else {
      const destinationEntries = (await fsOps.readdir(destinationRoot)).filter((/** @type {string} */ name) => name !== LOCK);
      const expectedTopLevels = new Set(files.map((file) => file.relative.split("/")[0]));
      const stageName = `.migration-stage-${migrationId}`;
      const generated = destinationEntries.filter((/** @type {string} */ name) => expectedTopLevels.has(name));
      const stagePresent = destinationEntries.includes(stageName);
      const temporaryNames = destinationEntries.filter((/** @type {string} */ name) => name.startsWith(`.${MANIFEST}.`) && name.endsWith(".tmp"));
      if (destinationEntries.some((/** @type {string} */ name) => !expectedTopLevels.has(name) && name !== stageName && !temporaryNames.includes(name))) throw migrationError("DESTINATION_COLLISION", "Destination is not empty");
      if (stagePresent) { await validateRecoveryFiles(join(destinationRoot, stageName), files, false, fsOps); await fsOps.rm(join(destinationRoot, stageName), { recursive: true, force: true }); }
      for (const name of temporaryNames) {
        const temporary = JSON.parse(await fsOps.readFile(join(destinationRoot, name), "utf8"));
        if (temporary.migrationId !== migrationId || temporary.sourceIdentity !== tree.identity) throw migrationError("DESTINATION_COLLISION", "Interrupted manifest identity changed");
        await fsOps.rm(join(destinationRoot, name), { force: true });
      }
      if (generated.length > 0) {
        await validateRecoveryFiles(destinationRoot, files, true, fsOps);
        const timestamp = new Date().toISOString();
        published = { schemaVersion: 1, migrationId, sourceIdentity: tree.identity, destinationIdentity, state: "PUBLISHED", configFrom: 1, configTo: 2, createdAt: timestamp, updatedAt: timestamp };
      }
    }
    if (published === undefined) {
      await failpoint("staging_start");
      const stage = join(destinationRoot, `.migration-stage-${migrationId}`);
      await fsOps.mkdir(stage, { mode: DIRECTORY_MODE });
      for (const entry of preparedEntries) {
        const target = join(stage, entry.relative);
        if (entry.type === "directory") { await fsOps.mkdir(target, { recursive: true, mode: DIRECTORY_MODE }); await fsOps.chmod(target, DIRECTORY_MODE); continue; }
        await fsOps.mkdir(dirname(target), { recursive: true, mode: DIRECTORY_MODE });
        await durableFile(target, entry.text ?? "", fsOps); await failpoint("after_staged_file_fsync");
      }
      await Promise.all(preparedEntries.filter((entry) => entry.type === "directory").map((entry) => syncDirectory(join(stage, entry.relative), fsOps)));
      await syncDirectory(stage, fsOps);
      for (const entry of await fsOps.readdir(stage)) await fsOps.rename(join(stage, entry), join(destinationRoot, entry));
      await fsOps.rmdir(stage); await syncDirectory(destinationRoot, fsOps);
      const timestamp = new Date().toISOString();
      published = { schemaVersion: 1, migrationId, sourceIdentity: tree.identity, destinationIdentity, state: "PUBLISHED", configFrom: 1, configTo: 2, createdAt: timestamp, updatedAt: timestamp };
      const manifestTemporary = join(destinationRoot, `.${MANIFEST}.${randomUUID()}.tmp`);
      await durableFile(manifestTemporary, `${JSON.stringify(published, null, 2)}\n`, fsOps); await failpoint("before_manifest_rename");
      await fsOps.rename(manifestTemporary, manifestPath); await syncDirectory(destinationRoot, fsOps); await failpoint("after_manifest_publication");
    }
    if (published.state === "RECONCILED") {
      await fsOps.rm(join(destinationRoot, RECONCILIATION_MARKER), { force: true }); await syncDirectory(destinationRoot, fsOps);
      await durableFile(join(destinationRoot, CANONICAL_MARKER), `${migrationId}\n`, fsOps); await syncDirectory(destinationRoot, fsOps);
      await durableFile(join(legacyRoot, LEGACY_MARKER), `${migrationId}\n`, fsOps); await syncDirectory(legacyRoot, fsOps);
      return { status: "MIGRATED", migrationId, manifestPath };
    }
    const reconciliationMarkerPath = join(destinationRoot, RECONCILIATION_MARKER);
    const reconciliationMarker = await fsOps.readFile(reconciliationMarkerPath, "utf8").then((/** @type {string} */ value) => value.trim()).catch((/** @type {NodeJS.ErrnoException} */ error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (reconciliationMarker === undefined) { await durableFile(reconciliationMarkerPath, `${migrationId}\n`, fsOps); await syncDirectory(destinationRoot, fsOps); }
    else if (reconciliationMarker !== migrationId) throw migrationError("MIGRATION_IDENTITY_MISMATCH", "Reconciliation marker belongs to another migration");
    await reconcileDestination({ root: destinationRoot, migrationId, manifest: published });
    await failpoint("before_reconciliation_completion");
    const completed = { ...published, state: "RECONCILED", updatedAt: new Date().toISOString() }; await replaceJson(manifestPath, completed, fsOps);
    await fsOps.rm(reconciliationMarkerPath, { force: true }); await syncDirectory(destinationRoot, fsOps);
    await failpoint("after_reconciliation");
    await durableFile(join(destinationRoot, CANONICAL_MARKER), `${migrationId}\n`, fsOps); await syncDirectory(destinationRoot, fsOps);
    await durableFile(join(legacyRoot, LEGACY_MARKER), `${migrationId}\n`, fsOps); await syncDirectory(legacyRoot, fsOps);
    return { status: "MIGRATED", migrationId, manifestPath };
  } finally { for (const release of releases.reverse()) await release().catch(() => {}); }
}
