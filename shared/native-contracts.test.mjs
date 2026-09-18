import { expect, it } from "vitest";

import {
  nextAttachmentEpoch,
  parseAttachmentEpoch,
  parseCanonicalBinding,
  parseCanonicalOperation,
  parseNativeSubmitBinding,
  parseOwnerRunIdentity,
  parseSubmissionEnvelope,
  readSeamVersions,
} from "./native-contracts.mjs";

const identity = { initialRowId: "row-1", runId: "run-1", ownerPid: 4321, ownerStartIdentity: "18446744073709551615", hostId: "host-1", bootId: "b6f1e3c2-0000-4000-8000-000000000001" };
const hostBinding = { currentRowId: "row-2", canonicalFile: "/sessions/2026-09-17-a.jsonl", device: "2049", inode: "918273", generation: 3 };
const nativeBinding = { canonicalFile: "/sessions/2026-09-17-a.jsonl", generation: 3 };
const attachmentBytes = new Uint8Array([1, 2, 3]);
// The actual SHA-256 of those three bytes, written out so the fixture does not borrow the validator's own digest.
const digest = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const envelope = { submissionId: "sub-1", ownerRunId: "run-1", binding: nativeBinding, source: "native-editor", intent: "prompt", originalText: "  ship it  ", behavior: "idle", draftRevision: 7 };
const operation = { operationId: "op-1", operation: "fork", currentBinding: nativeBinding, resolvedTarget: { canonicalFile: "/sessions/2026-09-17-b.jsonl" } };

it("accepts a complete owner run identity and refuses an incomplete or row-confused one", () => {
  expect(parseOwnerRunIdentity({ ...identity })).toEqual(identity);
  for (const key of Object.keys(identity)) {
    const partial = { ...identity };
    delete partial[/** @type {keyof typeof identity} */ (key)];
    expect(() => parseOwnerRunIdentity(partial), `identity without ${key}`).toThrow(new RegExp(key, "u"));
  }
  expect(() => parseOwnerRunIdentity({ ...identity, currentRowId: "row-2" })).toThrow(/unknown/iu);
  expect(() => parseOwnerRunIdentity({ ...identity, ownerPid: 0 })).toThrow(/ownerPid/u);
});

it("accepts a host-owned canonical binding and keeps it distinct from the identity's initial row", () => {
  expect(parseCanonicalBinding({ ...hostBinding })).toEqual(hostBinding);
  expect(() => parseCanonicalBinding({ ...hostBinding, initialRowId: "row-1" })).toThrow(/unknown/iu);
  expect(() => parseCanonicalBinding({ currentRowId: "row-2", canonicalFile: hostBinding.canonicalFile, generation: 3 })).toThrow(/device/u);
  expect(() => parseCanonicalBinding({ ...hostBinding, device: 2049, inode: 918273 })).toThrow(/device/u);
  expect(() => parseCanonicalBinding({ ...hostBinding, canonicalFile: "/sessions/" })).toThrow(/canonicalFile/u);
  expect(() => parseCanonicalBinding({ ...hostBinding, generation: 0 })).toThrow(/generation/u);
});

it("validates the minimal seam A binding separately from host registry metadata", () => {
  expect(parseNativeSubmitBinding({ canonicalFile: undefined, generation: 0 })).toEqual({ canonicalFile: undefined, generation: 0 });
  expect(parseNativeSubmitBinding({ ...nativeBinding })).toEqual(nativeBinding);
  for (const extra of [{ currentRowId: "row-2" }, { device: "2049" }, { inode: "918273" }]) expect(() => parseNativeSubmitBinding({ ...nativeBinding, ...extra }), `binding with ${Object.keys(extra)[0]}`).toThrow(/unknown/iu);
  // A disposed owner is rebound to undefined, which advances the generation: that state is reachable and valid.
  expect(parseNativeSubmitBinding({ canonicalFile: undefined, generation: 4 })).toEqual({ canonicalFile: undefined, generation: 4 });
  expect(() => parseNativeSubmitBinding({ generation: 0 })).toThrow(/canonicalFile/u);
  expect(() => parseNativeSubmitBinding({ canonicalFile: undefined, generation: -1 })).toThrow(/generation/u);
  expect(() => parseNativeSubmitBinding({ canonicalFile: undefined, generation: 1.5 })).toThrow(/generation/u);
  expect(() => parseNativeSubmitBinding({ canonicalFile: "sessions/a.jsonl", generation: 1 })).toThrow(/canonicalFile/u);
});

it("issues strictly increasing attachment epochs and refuses an unusable or exhausted one", () => {
  expect(nextAttachmentEpoch("attachment-1", null)).toEqual({ attachmentId: "attachment-1", epoch: 1 });
  const second = nextAttachmentEpoch("attachment-1", { attachmentId: "attachment-1", epoch: 1 });
  expect(second).toEqual({ attachmentId: "attachment-1", epoch: 2 });
  expect(nextAttachmentEpoch("attachment-1", second).epoch).toBeGreaterThan(second.epoch);
  expect(parseAttachmentEpoch({ ...second })).toEqual(second);
  for (const epoch of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 2]) expect(() => parseAttachmentEpoch({ attachmentId: "attachment-1", epoch }), `epoch ${epoch}`).toThrow(/epoch/u);
  expect(() => nextAttachmentEpoch("attachment-2", second)).toThrow(/attachmentId/u);
  expect(() => nextAttachmentEpoch("attachment-1", { attachmentId: "attachment-1", epoch: Number.MAX_SAFE_INTEGER })).toThrow(/exhausted/u);
});

it("accepts a submission envelope with content-addressed attachments and refuses a described count", () => {
  expect(parseSubmissionEnvelope({ ...envelope })).toEqual(envelope);
  const attachments = [{ kind: "image", mediaType: "image/png", byteLength: 3, sha256: digest, bytes: attachmentBytes }];
  expect(parseSubmissionEnvelope({ ...envelope, attachments, parentSubmissionId: "sub-0" }).attachments).toEqual(attachments);
  expect(parseSubmissionEnvelope({ ...envelope, originalText: "" }).originalText).toBe("");
  for (const key of ["originalText", "draftRevision", "binding", "source", "intent", "behavior"]) {
    const partial = { ...envelope };
    delete partial[/** @type {keyof typeof envelope} */ (key)];
    expect(() => parseSubmissionEnvelope(partial), `envelope without ${key}`).toThrow(new RegExp(key, "u"));
  }
  expect(() => parseSubmissionEnvelope({ ...envelope, attachments: 1 })).toThrow(/attachments/u);
  expect(() => parseSubmissionEnvelope({ ...envelope, attachments: [{ kind: "image", mediaType: "image/png" }] })).toThrow(/byteLength/u);
  expect(() => parseSubmissionEnvelope({ ...envelope, attachments: [{ kind: "image", mediaType: "image/png", byteLength: 3, sha256: "A".repeat(64), bytes: attachmentBytes }] })).toThrow(/sha256/u);
  expect(() => parseSubmissionEnvelope({ ...envelope, attachments: [{ kind: "image", mediaType: "image/png", byteLength: 3, sha256: digest }] })).toThrow(/bytes/u);
  expect(() => parseSubmissionEnvelope({ ...envelope, attachments: [{ ...attachments[0], sha256: "a".repeat(64) }] })).toThrow(/sha256/u);
  expect(() => parseSubmissionEnvelope({ ...envelope, attachments: [{ ...attachments[0], bytes: new Uint8Array([1]) }] })).toThrow(/bytes/u);
  expect(() => parseSubmissionEnvelope({ ...envelope, attachments: [{ ...attachments[0], bytes: [1, 2, 3] }] })).toThrow(/bytes/u);
  expect(() => parseSubmissionEnvelope({ ...envelope, source: "dashboard" })).toThrow(/source/u);
  expect(() => parseSubmissionEnvelope({ ...envelope, intent: "compact" })).toThrow(/intent/u);
  expect(() => parseSubmissionEnvelope({ ...envelope, attachmentOrigin: { attachmentId: "attachment-1", epoch: 1 } })).toThrow(/unknown/iu);
});

it("admits a canonical operation only against an exact target and the minimal current binding", () => {
  expect(parseCanonicalOperation({ ...operation })).toEqual(operation);
  expect(() => parseCanonicalOperation({ ...operation, resolvedTarget: { canonicalFile: "/sessions/" } })).toThrow(/canonicalFile/u);
  expect(() => parseCanonicalOperation({ ...operation, resolvedTarget: { canonicalFile: "/sessions/2026-09-17-*.jsonl" } })).toThrow(/canonicalFile/u);
  expect(() => parseCanonicalOperation({ ...operation, resolvedTarget: { directory: "/sessions", pattern: "*.jsonl" } })).toThrow(/unknown|canonicalFile/iu);
  expect(() => parseCanonicalOperation({ ...operation, currentBinding: hostBinding })).toThrow(/unknown/iu);
  expect(() => parseCanonicalOperation({ ...operation, operation: "compact" })).toThrow(/operation/u);
  expect(() => parseCanonicalOperation({ ...operation, unknown: true })).toThrow(/unknown/iu);
});

it("reports only the seam versions an owner genuinely reported", () => {
  expect(readSeamVersions(undefined)).toEqual({});
  expect(readSeamVersions(null)).toEqual({});
  expect(readSeamVersions({})).toEqual({});
  expect(readSeamVersions({ A: 1, D: 2 })).toEqual({ A: 1, D: 2 });
  expect(readSeamVersions({ A: 1, B: 0, C: -1, D: 1.5, E: "1", F: null, Z: 9 })).toEqual({ A: 1 });
  expect(() => readSeamVersions("A=1")).toThrow(/seam versions/u);
});

it("does not report a seam version inherited from Object.prototype as one the owner reported", () => {
  Object.defineProperty(Object.prototype, "A", { value: 9, configurable: true, writable: true });
  try {
    expect(readSeamVersions({})).toEqual({});
    expect(readSeamVersions({ D: 2 })).toEqual({ D: 2 });
    expect(readSeamVersions({ A: 1 })).toEqual({ A: 1 });
  } finally {
    Reflect.deleteProperty(Object.prototype, "A");
  }
});
