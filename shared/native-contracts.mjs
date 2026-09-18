/**
 * Strict validators for the identities the native attachment seams exchange.
 *
 * Three independent validators already live in this directory, so these follow the same rules: every
 * parser is total, every record is exact, and an unknown key is refused rather than ignored. Nothing here
 * persists, mints or authorizes anything — these are shapes, so a host and a native seam cannot disagree
 * silently about what a record means. No caller imports this module yet.
 *
 * Two boundaries are deliberately separate:
 *
 * - `parseNativeSubmitBinding` is the **minimal** binding Pi actually publishes at seams A and D:
 *   `{canonicalFile, generation}` and nothing else. Pi is never asked for a registry row, a device or an
 *   inode, so those keys are refused there.
 * - `parseCanonicalBinding` is the **host-owned** record: the same canonical file plus the row the owner
 *   writes now and the device/inode the host resolved itself. The host enriches Pi's binding; it never
 *   asks Pi to produce host metadata.
 *
 * `initialRowId` (the row an owner was launched against) and `currentRowId` (the row of the file it writes
 * now) are separate fields on separate records, because `switchSession` moves an owner to another file. A
 * record carrying the other one is refused as unknown.
 *
 * Device and inode stay strings: an inode can exceed the safe-integer range, and a device number is an
 * opaque identifier this project only ever compares for equality.
 */

import { createHash } from "node:crypto";

/** @typedef {{initialRowId:string,runId:string,ownerPid:number,ownerStartIdentity:string,hostId:string,bootId:string}} OwnerRunIdentity */
/** @typedef {{currentRowId:string,canonicalFile:string,device:string,inode:string,generation:number}} CanonicalBinding */
/** @typedef {{canonicalFile:string|undefined,generation:number}} NativeSubmitBinding */
/** @typedef {{attachmentId:string,epoch:number}} AttachmentEpoch */
/** @typedef {"native-editor"|"native-followup"|"native-steer"|"compaction-queue"|"builtin-command"|"extension-command"|"startup-prompt"|"extension-api"} SubmissionSource */
/** @typedef {"prompt"|"steer"|"follow_up"|"command"} SubmissionIntent */
/** @typedef {{kind:"image"|"file",mediaType:string,byteLength:number,sha256:string,bytes:Uint8Array}} SubmissionAttachment */
/** @typedef {{submissionId:string,ownerRunId:string,binding:NativeSubmitBinding,source:SubmissionSource,intent:SubmissionIntent,originalText:string,attachments?:SubmissionAttachment[],behavior:"idle"|"streaming",draftRevision:number,parentSubmissionId?:string}} SubmissionEnvelope */
/** @typedef {"startup"|"new"|"fork"|"resume"|"import"|"rename"|"delete"} CanonicalOperationKind */
/** @typedef {{operationId:string,operation:CanonicalOperationKind,currentBinding:NativeSubmitBinding,resolvedTarget:{canonicalFile:string}}} CanonicalOperation */

/** Every native entry point that can start a submission, as seam A declares them. */
const SUBMISSION_SOURCES = ["native-editor", "native-followup", "native-steer", "compaction-queue", "builtin-command", "extension-command", "startup-prompt", "extension-api"];
const SUBMISSION_INTENTS = ["prompt", "steer", "follow_up", "command"];
const CANONICAL_OPERATIONS = ["startup", "new", "fork", "resume", "import", "rename", "delete"];
/** The seven native seams named in the design. This project asserts no version of its own for any of them. */
const SEAM_NAMES = ["A", "B", "C", "D", "E", "F", "G"];
const MAX_PATH_LENGTH = 4096;
// `originalText` is the operator's text before trim, paste-marker expansion, transform or skill
// expansion, so it is bounded by what a paste can reasonably carry, not by a message limit.
const MAX_ORIGINAL_TEXT = 1_048_576;

/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function record(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${path} must be a plain object`);
  return value;
}

/** @param {Record<string, any>} value @param {readonly string[]} required @param {readonly string[]} optional @param {string} path */
function exact(value, required, optional, path) {
  const allowed = [...required, ...optional];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`Unknown ${path} field: ${unknown}`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new TypeError(`${path}.${missing} is required`);
}

/** @param {unknown} value @param {string} path @param {number} [maxLength] */
function identifier(value, path, maxLength = 256) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > maxLength) throw new TypeError(`${path} must be a bounded non-empty identifier`);
}

/** @param {unknown} value @param {readonly string[]} values @param {string} path */
function enumeration(value, values, path) { if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${path} is invalid`); }

/** @param {unknown} value @param {string} path @param {number} minimum */
function counter(value, path, minimum) { if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < minimum) throw new TypeError(`${path} must be a safe integer of at least ${minimum}`); }

/**
 * One exact existing-or-intended file, never a directory and never a pattern.
 *
 * An earlier draft reserved a directory plus a pattern, which left a window where the file existed and no
 * reservation named it. The admitted target is therefore the final absolute normalized filename.
 * @param {unknown} value @param {string} path
 */
function canonicalFilePath(value, path) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > MAX_PATH_LENGTH) throw new TypeError(`${path} must be a bounded non-empty path`);
  if (!value.startsWith("/") || value.endsWith("/")) throw new TypeError(`${path} must be an absolute file path, not a relative path or a directory`);
  if (/\/\/|\/\.\.?(?:\/|$)/u.test(value)) throw new TypeError(`${path} must be a normalized absolute path`);
  if (/[*?[\]{}\0]/u.test(value)) throw new TypeError(`${path} must be an exact path, not a pattern`);
}

/** @param {unknown} value @param {string} path */
function contentDigest(value, path) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${path} must be a lowercase hex sha256 digest`); }

/** One owner process lifetime, stamped on every reservation. @param {unknown} value @returns {OwnerRunIdentity} */
export function parseOwnerRunIdentity(value) {
  const identity = record(value, "owner run identity");
  exact(identity, ["initialRowId", "runId", "ownerPid", "ownerStartIdentity", "hostId", "bootId"], [], "owner run identity");
  for (const key of ["initialRowId", "runId", "ownerStartIdentity", "hostId", "bootId"]) identifier(identity[key], `owner run identity.${key}`);
  counter(identity.ownerPid, "owner run identity.ownerPid", 1);
  return /** @type {OwnerRunIdentity} */ (identity);
}

/**
 * The host's record of the file one owner writes now, enriched with metadata the host resolved itself.
 *
 * A bound file is always at generation 1 or higher: the first undefined-to-file bind already advanced it.
 * @param {unknown} value @returns {CanonicalBinding}
 */
export function parseCanonicalBinding(value) {
  const binding = record(value, "canonical binding");
  exact(binding, ["currentRowId", "canonicalFile", "device", "inode", "generation"], [], "canonical binding");
  identifier(binding.currentRowId, "canonical binding.currentRowId");
  canonicalFilePath(binding.canonicalFile, "canonical binding.canonicalFile");
  identifier(binding.device, "canonical binding.device", 64);
  identifier(binding.inode, "canonical binding.inode", 64);
  counter(binding.generation, "canonical binding.generation", 1);
  return /** @type {CanonicalBinding} */ (binding);
}

/**
 * The minimal binding Pi publishes at seams A and D, and the only binding a native callback carries.
 *
 * `canonicalFile` is present and `undefined` whenever no owner session is bound — before the first save,
 * and again after a bound owner is disposed. The generation advances on every change of the canonical
 * value, so an undefined file at a positive generation is a state the fixed implementation reaches.
 * @param {unknown} value @returns {NativeSubmitBinding}
 */
export function parseNativeSubmitBinding(value) {
  const binding = record(value, "native submit binding");
  exact(binding, ["canonicalFile", "generation"], [], "native submit binding");
  if (binding.canonicalFile !== undefined) canonicalFilePath(binding.canonicalFile, "native submit binding.canonicalFile");
  counter(binding.generation, "native submit binding.generation", 0);
  return /** @type {NativeSubmitBinding} */ (binding);
}

/** One attachment connection generation. Epochs start at 1, strictly increase and are never reused. @param {unknown} value @returns {AttachmentEpoch} */
export function parseAttachmentEpoch(value) {
  const epoch = record(value, "attachment epoch");
  exact(epoch, ["attachmentId", "epoch"], [], "attachment epoch");
  identifier(epoch.attachmentId, "attachment epoch.attachmentId");
  counter(epoch.epoch, "attachment epoch.epoch", 1);
  return /** @type {AttachmentEpoch} */ (epoch);
}

/**
 * Issue the epoch after `previous` for one attachment id; `previous` is `null` before the first issue.
 *
 * Refusing exhaustion matters more than it looks: silently returning a non-integer above
 * `MAX_SAFE_INTEGER` would let a delayed reconnect compare equal to the connection that replaced it.
 * @param {string} attachmentId @param {AttachmentEpoch|null} previous @returns {AttachmentEpoch}
 */
export function nextAttachmentEpoch(attachmentId, previous) {
  identifier(attachmentId, "attachment epoch.attachmentId");
  if (previous === null) return { attachmentId, epoch: 1 };
  const current = parseAttachmentEpoch(previous);
  if (current.attachmentId !== attachmentId) throw new TypeError("attachment epoch.attachmentId does not match the previous epoch");
  if (current.epoch >= Number.MAX_SAFE_INTEGER) throw new RangeError("attachment epoch space is exhausted; no further epoch can be issued");
  return { attachmentId, epoch: current.epoch + 1 };
}

/**
 * One attachment as seam A carries it: the actual bytes plus descriptors that describe those bytes.
 *
 * The digest is recomputed rather than trusted. A descriptor whose `sha256` names other content would let
 * a host persist one blob under another blob's address, which is the one thing content addressing is for.
 * @param {unknown} value @param {string} path @returns {SubmissionAttachment}
 */
function submissionAttachment(value, path) {
  const attachment = record(value, path);
  exact(attachment, ["kind", "mediaType", "byteLength", "sha256", "bytes"], [], path);
  enumeration(attachment.kind, ["image", "file"], `${path}.kind`);
  identifier(attachment.mediaType, `${path}.mediaType`);
  counter(attachment.byteLength, `${path}.byteLength`, 0);
  contentDigest(attachment.sha256, `${path}.sha256`);
  if (!(attachment.bytes instanceof Uint8Array)) throw new TypeError(`${path}.bytes must be a Uint8Array`);
  if (attachment.bytes.byteLength !== attachment.byteLength) throw new TypeError(`${path}.bytes length does not match ${path}.byteLength`);
  if (createHash("sha256").update(attachment.bytes).digest("hex") !== attachment.sha256) throw new TypeError(`${path}.sha256 is not the digest of ${path}.bytes`);
  return /** @type {SubmissionAttachment} */ (attachment);
}

/**
 * One native submission, as seam A hands it to the host before any semantic mutation.
 *
 * An attachment is content-addressed: a count, or a descriptor without the bytes it addresses, is refused,
 * because the host must be able to persist the very blob it authorized. `originalText` may be empty or
 * untrimmed — it is the text before every transform, which is the point.
 * @param {unknown} value @returns {SubmissionEnvelope}
 */
export function parseSubmissionEnvelope(value) {
  const envelope = record(value, "submission envelope");
  exact(envelope, ["submissionId", "ownerRunId", "binding", "source", "intent", "originalText", "behavior", "draftRevision"], ["attachments", "parentSubmissionId"], "submission envelope");
  identifier(envelope.submissionId, "submission envelope.submissionId");
  identifier(envelope.ownerRunId, "submission envelope.ownerRunId");
  parseNativeSubmitBinding(envelope.binding);
  enumeration(envelope.source, SUBMISSION_SOURCES, "submission envelope.source");
  enumeration(envelope.intent, SUBMISSION_INTENTS, "submission envelope.intent");
  if (typeof envelope.originalText !== "string" || envelope.originalText.length > MAX_ORIGINAL_TEXT) throw new TypeError("submission envelope.originalText must be a bounded string");
  enumeration(envelope.behavior, ["idle", "streaming"], "submission envelope.behavior");
  counter(envelope.draftRevision, "submission envelope.draftRevision", 0);
  if (Object.hasOwn(envelope, "attachments")) {
    if (!Array.isArray(envelope.attachments)) throw new TypeError("submission envelope.attachments must be an array of described attachments");
    envelope.attachments.forEach((attachment, index) => submissionAttachment(attachment, `submission envelope.attachments[${index}]`));
  }
  if (Object.hasOwn(envelope, "parentSubmissionId")) identifier(envelope.parentSubmissionId, "submission envelope.parentSubmissionId");
  return /** @type {SubmissionEnvelope} */ (envelope);
}

/**
 * One canonical mutation awaiting admission, naming the exact target it will write.
 *
 * `currentBinding` is Pi's minimal binding, not the host-owned record: the native callback has no registry
 * row, device or inode to offer, and requiring them would make Pi read host state.
 * @param {unknown} value @returns {CanonicalOperation}
 */
export function parseCanonicalOperation(value) {
  const operation = record(value, "canonical operation");
  exact(operation, ["operationId", "operation", "currentBinding", "resolvedTarget"], [], "canonical operation");
  identifier(operation.operationId, "canonical operation.operationId");
  enumeration(operation.operation, CANONICAL_OPERATIONS, "canonical operation.operation");
  parseNativeSubmitBinding(operation.currentBinding);
  const target = record(operation.resolvedTarget, "canonical operation.resolvedTarget");
  exact(target, ["canonicalFile"], [], "canonical operation.resolvedTarget");
  canonicalFilePath(target.canonicalFile, "canonical operation.resolvedTarget.canonicalFile");
  return /** @type {CanonicalOperation} */ (operation);
}

/**
 * Read the seam versions an owner reported, keeping only the entries it genuinely reported.
 *
 * This is the one reader here that filters instead of refusing: the table is a foreign report forwarded
 * verbatim, so an unknown seam name or an unusable value is dropped rather than turned into a failure of
 * the owner that reported it. An absent table is no report at all, which is `{}`. A name the table only
 * inherits was never reported, so an own key is required before the value is read.
 * @param {unknown} reported @returns {Record<string, number>}
 */
export function readSeamVersions(reported) {
  if (reported === undefined || reported === null) return {};
  const table = record(reported, "seam versions");
  /** @type {Record<string, number>} */
  const versions = {};
  for (const name of SEAM_NAMES) {
    if (!Object.hasOwn(table, name)) continue;
    const version = table[name];
    if (Number.isSafeInteger(version) && version > 0) versions[name] = version;
  }
  return versions;
}
