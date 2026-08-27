/**
 * Collapse task state and process state into the one state a reader sees.
 *
 * Task state alone is misleading: a finished session still reports READY, which reads as
 * "ready to work" for a session whose process is gone.
 *
 * @param {import("../../shared/contracts.mjs").SessionRecord} session
 * @returns {"WORKING"|"WAITING"|"READY"|"SLEEPING"|"STARTING"|"EXITED"|"STOPPED"|"FAILED"|"STALE"}
 */
export function displaySessionState(session) {
  if (session.taskState === "FAILED") return "FAILED";
  if (session.taskState === "STOPPED") return "STOPPED";
  if (session.processState === "STALE") return "STALE";
  if (session.processState === "SLEEPING") return "SLEEPING";
  if (session.processState === "EXITED") return session.activity.kind === "launching" ? "STARTING" : "EXITED";
  return session.taskState === "WORKING" || session.taskState === "WAITING" ? session.taskState : "READY";
}
