import { describe, expect, it } from "vitest";

import { parseClientRequest, parseDaemonResponse, parseListChanged } from "./contracts.mjs";

const envelope = { version: 1, clientId: "client-1", requestId: "request-1" };

/** Every request payload the frozen version-1 wire accepts, one row per operation variant. @type {Array<[string, Record<string, any>]>} */
const acceptedRequests = [
  ["get_state", {}],
  ["launch", { prompt: "Run tests", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" } }],
  ["attach", { sessionId: "session", role: "composer" }],
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
  ["get_viewer_snapshot", { sessionId: "session" }],
  ["subscribe_viewer", { sessionId: "session", after: { daemonEpoch: "epoch", sessionId: "session", sequence: "2" } }],
  ["ack_viewer", { cursor: { daemonEpoch: "epoch", sessionId: "session", sequence: "2" } }],
  ["resolve_delivery", { targetClientId: "client", targetRequestId: "request", resolution: "abandon" }],
  ["get_session_commands", { sessionId: "session" }],
  ["get_settings", {}],
  ["set_settings", { summaryModel: { provider: "anthropic", id: "haiku" } }],
  ["set_settings", { summaryModel: null }],
  ["refresh_summaries", {}],
  ["set_session_color", { sessionId: "session", color: "amber" }],
  ["set_session_color", { sessionId: "session", color: null }],
  ["session_command", { sessionId: "session", command: "set_model", model: { provider: "anthropic", id: "claude" } }],
  ["session_command", { sessionId: "session", command: "compact", instructions: "keep decisions" }],
  ["session_command", { sessionId: "session", command: "abort_retry" }],
];

/** Every request the wire must refuse, beyond the per-variant unknown-field matrix. @type {Array<[string, string, Record<string, any>, RegExp]>} */
const rejectedRequests = [
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
  ["a thinking level Pi owns", "session_command", { sessionId: "session", command: "set_thinking_level", level: "high" }, /command/iu],
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
  // A running daemon that predates the thinking-control removal still answers with these two keys.
  // Refusing them made every viewer open against that daemon fail to parse and never answer.
  ["session command menu from a daemon that predates the thinking-control removal", ok({ ...menu, thinkingLevels: ["off", "high"], thinkingLevel: "off" })],
  ["summary settings", ok({ kind: "settings", summaryModel: { provider: "anthropic", id: "haiku" } })],
  ["summaries disabled", ok({ kind: "settings", summaryModel: null })],
  ["session state carrying a bounded summary", ok({ kind: "state", sessions: [sessionRecord], cursor: coverage })],
  ["session state carrying the daemon's coverage cursor", ok({ kind: "state", sessions: [sessionRecord], cursor: { daemonEpoch: "epoch", sequence: "6778" } })],
  ["session state reporting one adopted worker's release and route generation", ok({ kind: "state", sessions: [{ ...sessionRecord, workerCliVersion: "1.4.2", stale: false, routeGeneration: 3 }], cursor: coverage })],
  ["session state reporting an adopted worker whose release is unknown", ok({ kind: "state", sessions: [{ ...sessionRecord, stale: true, routeGeneration: 1 }], cursor: coverage })],
  ["a respawn command status", ok({ kind: "command", status: { clientId: "client", requestId: "request", operation: "respawn", stage: "COMPLETED", acceptedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } })],
  ["the installed Pi's model catalog", ok(modelCatalog)],
  ["an empty model catalog", ok({ kind: "models", models: [] })],
  ["typed failure", { version: 1, requestId: "request", ok: false, error: { code: "DENIED", message: "denied", retryable: false } }],
];

/** Every daemon response the wire must refuse. @type {Array<[string, Record<string, any>, RegExp]>} */
const rejectedResponses = [
  ["unknown menu field", ok({ ...menu, unknown: true }), /unknown/iu],
  ["invented menu command source", ok({ ...menu, commands: [{ name: "/x", source: "invented" }] }), /source/iu],
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
