import { describe, expect, it } from "vitest";

import { parseClientRequest, parseDaemonResponse, parseListChanged, parseViewerStreamFailed } from "./contracts.mjs";

const viewerCursor = { daemonEpoch: "epoch", sessionId: "session", sequence: "7" };
const viewerSnapshot = {
  version: 1, sessionId: "session", registryRevision: 2, cursor: viewerCursor, runtime: null,
  taskState: "READY", processState: "LIVE", outcome: "NONE",
  activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "source", startedAt: "2026-01-01T00:00:00.000Z" },
  model: null, thinkingLevel: null, items: [], tools: [], pendingUi: [], errors: [],
};

const envelope = { version: 1, clientId: "client-1", requestId: "request-1" };

/** Every request payload the frozen version-1 wire accepts, one row per operation variant. @type {Array<[string, Record<string, any>]>} */
const acceptedRequests = [
  ["get_state", {}],
  ["launch", { prompt: "Run tests", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" } }],
  ["attach", { sessionId: "session" }],
  ["attach", { sessionId: "session", activate: true }],
  ["detach", { sessionId: "session" }],
  ["prompt", { sessionId: "session", text: "next" }],
  ["follow_up", { sessionId: "session", text: "next" }],
  ["steer", { sessionId: "session", text: "next" }],
  ["interrupt", { sessionId: "session" }],
  ["ui_response", { sessionId: "session", uiRequestId: "ui", response: { answer: true } }],
  ["stop", { sessionId: "session", revision: 2 }],
  ["delete", { sessionId: "session", revision: 2 }],
  ["respawn", { sessionId: "session", revision: 2 }],
  ["subscribe_list_changes", {}],
  ["subscribe_viewer", { sessionId: "session" }],
  ["get_session_commands", { sessionId: "session" }],
  ["get_settings", {}],
  ["set_settings", { summaryModel: { provider: "anthropic", id: "haiku" } }],
  ["set_settings", { summaryModel: null }],
  ["refresh_summaries", {}],
  ["set_session_color", { sessionId: "session", color: "amber" }],
  ["set_session_color", { sessionId: "session", color: null }],
  ["session_command", { sessionId: "session", command: "set_model", model: { provider: "anthropic", id: "claude" } }],
  ["session_command", { sessionId: "session", command: "set_thinking_level", level: "high" }],
  ["session_command", { sessionId: "session", command: "compact", instructions: "keep decisions" }],
  ["session_command", { sessionId: "session", command: "abort_retry" }],
];

/** Every request the wire must refuse, beyond the per-variant unknown-field matrix. @type {Array<[string, string, Record<string, any>, RegExp]>} */
const rejectedRequests = [
  ["the retired viewer acknowledgement operation", "ack_viewer", { cursor: { daemonEpoch: "epoch", sessionId: "session", sequence: "2" } }, /operation must be one of/u],
  // The daemon keeps no viewer events, so there is nothing to fetch separately and nothing to resume from.
  ["the retired separate snapshot read", "get_viewer_snapshot", { sessionId: "session" }, /operation must be one of/u],
  ["a viewer resume cursor", "subscribe_viewer", { sessionId: "session", after: { daemonEpoch: "epoch", sessionId: "session", sequence: "2" } }, /unknown/iu],
  ["color outside the palette", "set_session_color", { sessionId: "session", color: "chartreuse" }, /color/iu],
  ["empty color", "set_session_color", { sessionId: "session", color: "" }, /color/iu],
  ["color without a session", "set_session_color", { color: "amber" }, /sessionId/iu],
  ["negative legacy revision", "set_session_color", { sessionId: "session", revision: -1, color: "amber" }, /revision/iu],
  ["non-integer legacy revision", "set_session_color", { sessionId: "session", revision: "3", color: "amber" }, /revision/iu],
  ["stop without a revision", "stop", { sessionId: "session" }, /revision/iu],
  ["delete without a revision", "delete", { sessionId: "session" }, /revision/iu],
  ["respawn without a revision", "respawn", { sessionId: "session" }, /revision/iu],
  ["session rebinding through new_session", "session_command", { sessionId: "session", command: "new_session" }, /command/iu],
  ["session rebinding through switch_session", "session_command", { sessionId: "session", command: "switch_session", sessionPath: "/other.jsonl" }, /command/iu],
  ["session rebinding through fork", "session_command", { sessionId: "session", command: "fork", entryId: "entry" }, /command/iu],
  ["a thinking level with no value", "session_command", { sessionId: "session", command: "set_thinking_level" }, /level/iu],
  ["an empty thinking level", "session_command", { sessionId: "session", command: "set_thinking_level", level: "" }, /level/iu],
  ["a thinking level that is not a string", "session_command", { sessionId: "session", command: "set_thinking_level", level: 3 }, /level/iu],
  ["a requested thinking level at launch", "launch", { prompt: "Run tests", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" }, thinkingLevel: "high" }, /unknown/iu],
  ["automatic compaction", "session_command", { sessionId: "session", command: "set_auto_compaction", enabled: true }, /command/iu],
  ["automatic retry", "session_command", { sessionId: "session", command: "set_auto_retry", enabled: false }, /command/iu],
  ["the steering queue mode", "session_command", { sessionId: "session", command: "set_steering_mode", mode: "all" }, /command/iu],
  ["the follow-up queue mode", "session_command", { sessionId: "session", command: "set_follow_up_mode", mode: "one-at-a-time" }, /command/iu],
  ["session statistics", "session_query", { sessionId: "session", query: "get_session_stats" }, /operation/iu],
  ["the entry tree", "session_query", { sessionId: "session", query: "get_tree" }, /operation/iu],
  ["an HTML export", "session_query", { sessionId: "session", query: "export_html" }, /operation/iu],
  ["an HTML export to a caller-chosen path", "session_query", { sessionId: "session", query: "export_html", outputPath: "/tmp/session.html" }, /operation/iu],
  // Ship only subscribe_list_changes. The retired operations are unknown to the strict contract;
  // there is no fallback and no special refusal for them.
  ["the retired list subscription", "subscribe", {}, /operation/iu],
  ["a retired list subscription resuming from a cursor", "subscribe", { after: { daemonEpoch: "epoch", sequence: "2" } }, /operation/iu],
  ["the retired list acknowledgement", "ack", { cursor: { daemonEpoch: "epoch", sequence: "2" } }, /operation/iu],
  // There is no daemon-side command journal, so there is no stage to resolve. An unattributable
  // outcome is reported once, as a DELIVERY_UNKNOWN failure, and the operator reissues.
  ["the retired delivery resolution", "resolve_delivery", { targetClientId: "client", targetRequestId: "request", resolution: "abandon" }, /operation must be one of/u],
];

const sessionRecord = { schemaVersion: 1, revision: 1, sessionId: "s", sessionFile: "/s.jsonl", canonicalSessionFile: "/s.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "idle", summary: "Idle", updatedAt: "2026-01-01T00:00:00.000Z" }, summary: { text: "Refactored the loader and ran tests", generatedAt: "2026-01-01T00:00:00.000Z", model: { provider: "anthropic", id: "haiku" }, sourceCursor: "42" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const menu = {
  kind: "session_commands", sessionId: "session",
  commands: [{ name: "/compact", source: "builtin", description: "Compact", argumentHint: "[instructions]" }, { name: "/review", source: "extension" }],
  models: [{ provider: "anthropic", id: "claude" }],
  model: { provider: "anthropic", id: "claude" },
};
const modelCatalog = { kind: "models", models: [{ provider: "anthropic", id: "claude-opus-4", thinking: true }, { provider: "google", id: "gemini-3-flash", thinking: false }] };
const coverage = { daemonEpoch: "epoch", sequence: "12" };

/** @param {Record<string, any>} result */
const ok = (result) => ({ version: 1, requestId: "request", ok: true, result });

/** Every daemon response shape the frozen version-1 wire accepts. @type {Array<[string, Record<string, any>]>} */
const acceptedResponses = [
  ["a list subscription", ok({ kind: "list_subscribed" })],
  ["session command menu", ok(menu)],
  ["session command menu carrying Pi's thinking levels", ok({ ...menu, thinkingLevels: ["off", "high"], thinkingLevel: "off" })],
  // A daemon from the release that carried no thinking values outlives the frontend that talks to it.
  ["session command menu with no thinking values at all", ok(menu)],
  ["session command menu whose model reports no level yet", ok({ ...menu, thinkingLevels: ["off"], thinkingLevel: null })],
  ["summary settings", ok({ kind: "settings", summaryModel: { provider: "anthropic", id: "haiku" } })],
  ["summaries disabled", ok({ kind: "settings", summaryModel: null })],
  ["session state carrying a bounded summary", ok({ kind: "state", sessions: [sessionRecord], cursor: coverage })],
  ["session state carrying the daemon's coverage cursor", ok({ kind: "state", sessions: [sessionRecord], cursor: { daemonEpoch: "epoch", sequence: "6778" } })],
  ["session state reporting one adopted worker's release and route generation", ok({ kind: "state", sessions: [{ ...sessionRecord, workerCliVersion: "1.4.2", stale: false, routeGeneration: 3 }], cursor: coverage })],
  ["session state reporting an adopted worker whose release is unknown", ok({ kind: "state", sessions: [{ ...sessionRecord, stale: true, routeGeneration: 1 }], cursor: coverage })],
  ["a respawn acknowledgement", ok({ kind: "command", sessionId: "session" })],
  ["the installed Pi's model catalog", ok(modelCatalog)],
  // One answer opens the stream and carries the snapshot it continues, because nothing is retained
  // that a second request could replay from.
  ["a viewer subscription and the snapshot it continues", ok({ kind: "viewer_subscribed", cursor: viewerCursor, snapshot: viewerSnapshot })],
  ["an empty model catalog", ok({ kind: "models", models: [] })],
  ["typed failure", { version: 1, requestId: "request", ok: false, error: { code: "DENIED", message: "denied", retryable: false } }],
];

/** Every daemon response the wire must refuse. @type {Array<[string, Record<string, any>, RegExp]>} */
const rejectedResponses = [
  ["unknown menu field", ok({ ...menu, unknown: true }), /unknown/iu],
  ["invented menu command source", ok({ ...menu, commands: [{ name: "/x", source: "invented" }] }), /source/iu],
  ["a thinking level list that is not a list", ok({ ...menu, thinkingLevels: "off" }), /thinkingLevels/u],
  ["an empty thinking level in the list", ok({ ...menu, thinkingLevels: ["off", ""] }), /thinkingLevels/u],
  ["an unbounded thinking level list", ok({ ...menu, thinkingLevels: Array.from({ length: 1_001 }, (_, index) => `level-${index}`) }), /thinkingLevels/u],
  ["an empty current thinking level", ok({ ...menu, thinkingLevel: "" }), /thinkingLevel/u],
  ["empty session summary text", ok({ kind: "state", sessions: [{ ...sessionRecord, summary: { ...sessionRecord.summary, text: "" } }], cursor: coverage }), /summary\.text/u],
  ["a state cursor whose sequence is not canonical", ok({ kind: "state", sessions: [], cursor: { daemonEpoch: "epoch", sequence: "01" } }), /sequence/u],
  // The snapshot's coverage cursor is what makes subscribe-then-read safe, so a state result
  // without one is unusable rather than a tolerable older shape.
  ["session state without its coverage cursor", ok({ kind: "state", sessions: [] }), /cursor is required/u],
  ["a route generation no adoption could have produced", ok({ kind: "state", sessions: [{ ...sessionRecord, routeGeneration: 0 }], cursor: coverage }), /routeGeneration/u],
  ["a stale flag that is not a boolean", ok({ kind: "state", sessions: [{ ...sessionRecord, stale: "yes" }], cursor: coverage }), /stale/u],
  ["an empty worker release string", ok({ kind: "state", sessions: [{ ...sessionRecord, workerCliVersion: "" }], cursor: coverage }), /workerCliVersion/u],
  ["a list subscription that carries a cursor", ok({ kind: "list_subscribed", cursor: coverage }), /unknown/iu],
  ["session query rows", ok({ kind: "session_query", sessionId: "session", query: "get_session_stats", rows: ["messages: 12"] }), /kind/iu],
  // The retired list-event protocol: one subscription that replayed a persisted history, and the
  // acknowledgement that moved a durable cursor through it.
  ["a retired list subscription", ok({ kind: "subscribed", cursor: coverage }), /kind/iu],
  ["a retired list acknowledgement", ok({ kind: "acknowledged", cursor: coverage }), /kind/iu],
  ["unknown model catalog field", ok({ ...modelCatalog, unknown: true }), /unknown/iu],
  ["unknown field on a catalog model", ok({ kind: "models", models: [{ provider: "anthropic", id: "claude", thinking: true, unknown: true }] }), /unknown/iu],
  ["a catalog model without a thinking flag", ok({ kind: "models", models: [{ provider: "anthropic", id: "claude" }] }), /thinking/iu],
  ["a catalog model with a non-boolean thinking flag", ok({ kind: "models", models: [{ provider: "anthropic", id: "claude", thinking: "yes" }] }), /thinking/iu],
  ["an unbounded model catalog", ok({ kind: "models", models: Array.from({ length: 2_001 }, (_, index) => ({ provider: "p", id: `m-${index}`, thinking: false })) }), /bounded/iu],
  ["unknown field on a failure", { version: 1, requestId: "request", ok: false, error: { code: "DENIED", message: "denied", retryable: false }, unknown: true }, /unknown/iu],
  ["a viewer subscription without the snapshot it continues", ok({ kind: "viewer_subscribed", cursor: viewerCursor }), /snapshot is required/u],
  ["a retired separate snapshot read", ok({ kind: "viewer_snapshot", snapshot: viewerSnapshot }), /kind/iu],
  // A command answer says which session it belongs to and nothing else. The delivery stage it used
  // to carry named a daemon-side journal record that no longer exists.
  ["a command answer carrying a durable delivery stage", ok({ kind: "command", sessionId: "session", status: { clientId: "client", requestId: "request", operation: "respawn", stage: "COMPLETED", acceptedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } }), /unknown/iu],
  ["a command answer without its session", ok({ kind: "command" }), /sessionId is required/u],
];

describe("command contracts", () => {
  it("accepts every exact request payload variant", () => {
    for (const [op, payload] of acceptedRequests) {
      const request = { ...envelope, op, payload };
      expect(parseClientRequest(request), `${op} ${JSON.stringify(payload)}`).toEqual(request);
    }
  });

  it("rejects unknown fields in every request payload variant", () => {
    for (const [op, payload] of acceptedRequests) {
      expect(() => parseClientRequest({ ...envelope, op, payload: { ...payload, unknown: true } }), `${op} ${JSON.stringify(payload)}`).toThrow(/unknown/iu);
    }
  });

  it("rejects every out-of-contract request payload", () => {
    for (const [name, op, payload, message] of rejectedRequests) {
      expect(() => parseClientRequest({ ...envelope, op, payload }), name).toThrow(message);
    }
  });

  it("tolerates a revision from an older client and drops it before the daemon sees it", () => {
    expect(parseClientRequest({ ...envelope, op: "set_session_color", payload: { sessionId: "session", revision: 3, color: "amber" } }))
      .toEqual({ ...envelope, op: "set_session_color", payload: { sessionId: "session", color: "amber" } });
  });

  it("accepts every exact daemon response variant", () => {
    for (const [name, response] of acceptedResponses) {
      expect(parseDaemonResponse(response), name).toEqual(response);
    }
  });

  it("rejects every out-of-contract daemon response", () => {
    for (const [name, response, message] of rejectedResponses) {
      expect(() => parseDaemonResponse(response), name).toThrow(message);
    }
  });

  // Operator-visible failure: a viewer whose stream stopped kept drawing the last state it had. The
  // establishing request is already answered by then, so this is a frame of its own rather than a
  // second response nothing would own.
  it("accepts one viewer stream failure and refuses anything else on that frame", () => {
    const failed = { version: 1, kind: "viewer_stream_failed", sessionId: "session", error: { code: "SUBSCRIBER_OVERFLOW", message: "bound reached", retryable: false } };
    expect(parseViewerStreamFailed(failed)).toEqual(failed);
    for (const [name, value] of [
      ["no session", { version: 1, kind: "viewer_stream_failed", error: failed.error }],
      ["no error", { version: 1, kind: "viewer_stream_failed", sessionId: "session" }],
      ["an event carried on it", { ...failed, event: { eventId: "event-1" } }],
      ["a version this release does not speak", { ...failed, version: 2 }],
    ]) {
      expect(() => parseViewerStreamFailed(value), /** @type {string} */ (name)).toThrow();
    }
  });

  // Operator-visible failure: replaying a persisted list history crashed the dashboard on every
  // start. The invalidation carries no payload at all, so nothing about it can grow with a burst.
  it("accepts the payload-free list invalidation and refuses anything carried on it", () => {
    const notification = { version: 1, kind: "list_changed" };
    expect(parseListChanged(notification)).toEqual(notification);
    for (const [name, value] of [
      ["a session payload", { version: 1, kind: "list_changed", payload: { session: sessionRecord } }],
      ["a cursor", { version: 1, kind: "list_changed", cursor: coverage }],
      ["a retired persisted list event", { version: 1, cursor: coverage, occurredAt: "2026-01-01T00:00:00.000Z", kind: "session_changed", payload: { session: sessionRecord } }],
      ["a version this release does not speak", { version: 2, kind: "list_changed" }],
    ]) {
      expect(() => parseListChanged(value), /** @type {string} */ (name)).toThrow();
    }
  });
});
