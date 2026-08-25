import { IsolationError, normalizeOwnerSessionIds } from "./launch-preflight.mjs";

/**
 * Confirm an explicit shared-directory warning against its exact path and owner snapshot.
 *
 * @param {any} preflight
 * @param {{ currentOwnerSessionIds?: string[] }} [options]
 */
export async function confirmSharedDirectory(preflight, options = {}) {
  if (
    preflight === null ||
    typeof preflight !== "object" ||
    preflight.mode !== "shared_directory_confirmation" ||
    typeof preflight.canonicalCwd !== "string" ||
    typeof preflight.confirmedCanonicalCwd !== "string" ||
    !Array.isArray(preflight.ownerSessionIds)
  ) {
    throw new IsolationError(
      "INVALID_SHARED_PREFLIGHT",
      "A shared-directory confirmation preflight is required",
    );
  }
  if (preflight.confirmedCanonicalCwd !== preflight.canonicalCwd) {
    throw new IsolationError(
      "CONFIRMATION_MISMATCH",
      "Shared-directory confirmation does not match the exact canonical cwd",
    );
  }

  const expectedOwners = normalizeOwnerSessionIds(preflight.ownerSessionIds);
  const currentOwners = normalizeOwnerSessionIds(options.currentOwnerSessionIds ?? []);
  if (
    expectedOwners.length !== currentOwners.length ||
    expectedOwners.some((owner, index) => owner !== currentOwners[index])
  ) {
    throw new IsolationError(
      "OWNERS_CHANGED",
      "Shared-directory owners changed after the warning was displayed",
    );
  }

  return {
    mode: "shared_directory",
    canonicalCwd: preflight.canonicalCwd,
    workerCwd: preflight.canonicalCwd,
    sourceSessionId: preflight.sourceSessionId,
    piConfigRoot: preflight.piConfigRoot,
  };
}
