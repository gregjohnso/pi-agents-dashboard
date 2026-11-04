/**
 * Collapse task state and process state into the one state a reader sees.
 *
 * Task state alone is misleading: a finished session still reports READY, which reads as
 * "ready to work" for a session whose process is gone.
 *
 * A worker being replaced across a release boundary is starting, not finished: the row would
 * otherwise read as a dead session for the whole time Pi takes to restart and resume.
 *
 * @param {import("../../shared/contracts.mjs").SessionRecord & { needsReview?: boolean, stateReported?: boolean }} session
 * @returns {"WORKING"|"WAITING"|"NEEDS INPUT"|"READY"|"UNKNOWN"|"SLEEPING"|"STARTING"|"EXITED"|"STOPPED"|"FAILED"|"STALE"}
 */
export function displaySessionState(session) {
  if (session.taskState === "FAILED") return "FAILED";
  if (session.taskState === "STOPPED") return "STOPPED";
  if (session.processState === "STALE") return "STALE";
  if (session.processState === "SLEEPING") return "SLEEPING";
  if (session.processState === "EXITED") return ["launching", "replacing"].includes(session.activity.kind) ? "STARTING" : "EXITED";
  // A producer that explicitly says it has no state to report gets an honest cell rather than the neutral
  // contract value dressed as READY. This is additive and optional: `stateReported` absent or true behaves
  // exactly as before, so every record that does not set it - the daemon's included - is unchanged, and no
  // durable process-boundary enum is widened or renamed.
  if (session.stateReported === false) return "UNKNOWN";
  if (session.taskState === "WORKING" || session.taskState === "WAITING") return session.taskState;
  // A finished turn the operator has not looked at yet.
  return session.needsReview === true ? "NEEDS INPUT" : "READY";
}
