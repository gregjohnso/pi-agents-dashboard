/** @typedef {import("../shared/contracts.mjs").SessionRecord} SessionRecord */

/** @typedef {{ summary: string }} ActivitySignal */

/**
 * @typedef {object} SessionStateEvent
 * @property {"WORKER_READY" | "TURN_STARTED" | "TURN_COMPLETED" | "TURN_READY_FOR_REVIEW" | "WORKER_SLEEPING" | "WORKER_EXITED" | "WORKER_REPLACING" | "USER_STOPPED" | "PI_CHILD_CRASHED" | "WORKER_CRASHED" | "IDENTITY_STALE" | "UI_REQUESTED" | "UI_RESPONDED" | "ACTIVITY_SNAPSHOT" | "LAUNCH_ABANDONED" | "FRONTEND_DETACHED"} type
 * @property {string} at
 * @property {string} [summary]
 * @property {ActivitySignal} [blockingRequest]
 * @property {ActivitySignal} [tool]
 * @property {ActivitySignal} [assistantStream]
 * @property {ActivitySignal} [finalAssistant]
 * @property {ActivitySignal} [processError]
 */

/**
 * @param {SessionRecord} record
 * @param {string} at
 * @param {Partial<SessionRecord>} changes
 * @returns {SessionRecord}
 */
function transition(record, at, changes) {
  return {
    ...record,
    ...changes,
    revision: record.revision + 1,
    updatedAt: at,
  };
}

/**
 * @param {SessionStateEvent} event
 * @returns {SessionRecord["activity"] | undefined}
 */
function selectActivity(event) {
  if (event.blockingRequest !== undefined) {
    return { kind: "blocking_request", summary: event.blockingRequest.summary, updatedAt: event.at };
  }
  if (event.tool !== undefined) {
    return { kind: "tool", summary: event.tool.summary, updatedAt: event.at };
  }
  if (event.assistantStream !== undefined) {
    return { kind: "assistant_stream", summary: event.assistantStream.summary, updatedAt: event.at };
  }
  if (event.finalAssistant !== undefined) {
    return { kind: "assistant_final", summary: event.finalAssistant.summary, updatedAt: event.at };
  }
  if (event.processError !== undefined) {
    return { kind: "process_error", summary: event.processError.summary, updatedAt: event.at };
  }
  return undefined;
}

/**
 * Reduce one runtime event without coupling task, process, outcome, and activity state.
 *
 * @param {SessionRecord} record
 * @param {SessionStateEvent} event
 * @returns {SessionRecord}
 */
export function reduceSessionState(record, event) {
  switch (event.type) {
    case "WORKER_READY":
      return transition(record, event.at, {
        taskState: "READY",
        processState: "LIVE",
        outcome: "NONE",
      });
    case "TURN_STARTED":
      return transition(record, event.at, {
        taskState: "WORKING",
        processState: "LIVE",
        outcome: "NONE",
      });
    case "TURN_COMPLETED":
      return transition(record, event.at, {
        taskState: "READY",
        processState: "LIVE",
        outcome: "COMPLETED",
      });
    case "TURN_READY_FOR_REVIEW":
      return transition(record, event.at, {
        taskState: "READY",
        processState: "LIVE",
        outcome: "READY_FOR_REVIEW",
      });
    case "WORKER_SLEEPING":
      return transition(record, event.at, {
        taskState: "READY",
        processState: "SLEEPING",
        outcome: record.outcome,
      });
    case "WORKER_EXITED":
      if (record.taskState === "FAILED" && record.processState === "EXITED" && record.activity.kind === "process_error") return record;
      return transition(record, event.at, {
        taskState: "READY",
        processState: "EXITED",
        outcome: record.outcome,
      });
    case "WORKER_REPLACING":
      // Task and process state stay where they are: the worker is still running here, and the exit
      // this activity outlives is the replacement's own. It reads as a start in progress until the
      // replacement worker reports ready, exactly as a launch does.
      return transition(record, event.at, {
        activity: {
          kind: "replacing",
          summary: event.summary ?? "Replacing this session's worker for the current release",
          updatedAt: event.at,
        },
      });
    case "USER_STOPPED":
      return transition(record, event.at, {
        taskState: "STOPPED",
        processState: "EXITED",
        outcome: "NONE",
      });
    case "PI_CHILD_CRASHED":
      return transition(record, event.at, {
        taskState: "FAILED",
        processState: "EXITED",
        outcome: "NONE",
        activity: {
          kind: "process_error",
          summary: event.summary ?? "Pi child process exited unexpectedly",
          updatedAt: event.at,
        },
      });
    case "WORKER_CRASHED":
    case "IDENTITY_STALE":
      return transition(record, event.at, {
        processState: "STALE",
        activity: {
          kind: "process_error",
          summary: event.summary ?? "Worker identity is stale",
          updatedAt: event.at,
        },
      });
    case "UI_REQUESTED":
      return transition(record, event.at, {
        taskState: "WAITING",
        activity: {
          kind: "blocking_request",
          summary: event.summary ?? "Waiting for user response",
          updatedAt: event.at,
        },
      });
    case "UI_RESPONDED":
      return transition(record, event.at, {
        taskState: "WORKING",
        activity: {
          kind: "worker",
          summary: event.summary ?? "User response received",
          updatedAt: event.at,
        },
      });
    case "LAUNCH_ABANDONED":
      return transition(record, event.at, {
        taskState: "FAILED",
        processState: "EXITED",
        outcome: "NONE",
        activity: {
          kind: "launch_failed",
          summary: event.summary ?? "Launch did not start before the daemon exited",
          updatedAt: event.at,
        },
      });
    case "ACTIVITY_SNAPSHOT": {
      const activity = selectActivity(event);
      return activity === undefined ? record : transition(record, event.at, { activity });
    }
    case "FRONTEND_DETACHED":
      return record;
    default:
      throw new TypeError(`Unknown session state event: ${event.type}`);
  }
}
