import { describe, expect, it } from "vitest";

import { parseClientRequest, parseDaemonResponse } from "./contracts.mjs";

const envelope = { version: 1, clientId: "client-1", requestId: "request-1" };

/** @type {Array<[string, Record<string, any>]>} */
const variants = [
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
  ["subscribe", {}],
  ["ack", { cursor: { daemonEpoch: "epoch", sequence: "2" } }],
  ["get_viewer_snapshot", { sessionId: "session" }],
  ["subscribe_viewer", { sessionId: "session", after: { daemonEpoch: "epoch", sessionId: "session", sequence: "2" } }],
  ["ack_viewer", { cursor: { daemonEpoch: "epoch", sessionId: "session", sequence: "2" } }],
  ["resolve_delivery", { targetClientId: "client", targetRequestId: "request", resolution: "abandon" }],
  ["get_session_commands", { sessionId: "session" }],
  ["get_settings", {}],
  ["set_settings", { summaryModel: { provider: "anthropic", id: "haiku" } }],
  ["set_settings", { summaryModel: null }],
  ["refresh_summaries", {}],
  ["session_command", { sessionId: "session", command: "set_model", model: { provider: "anthropic", id: "claude" } }],
  ["session_command", { sessionId: "session", command: "set_thinking_level", level: "high" }],
  ["session_command", { sessionId: "session", command: "compact", instructions: "keep decisions" }],
];

describe("command contracts", () => {
  it("accepts every exact request payload variant", () => {
    for (const [op, payload] of variants) {
      const request = { ...envelope, op, payload };
      expect(parseClientRequest(request)).toEqual(request);
    }
  });

  it("rejects unknown fields in every request payload variant", () => {
    for (const [op, payload] of variants) {
      expect(() => parseClientRequest({ ...envelope, op, payload: { ...payload, unknown: true } })).toThrow(/unknown/i);
    }
  });

  it("keeps Stop and Delete bound to exact revisions", () => {
    for (const op of ["stop", "delete"]) {
      expect(() => parseClientRequest({ ...envelope, op, payload: { sessionId: "session" } })).toThrow(/revision/i);
    }
  });

  it("parses one bounded session command menu and rejects unknown menu fields", () => {
    const result = {
      kind: "session_commands", sessionId: "session",
      commands: [{ name: "/compact", source: "builtin", description: "Compact", argumentHint: "[instructions]" }, { name: "/review", source: "extension" }],
      models: [{ provider: "anthropic", id: "claude" }], thinkingLevels: ["off", "high"],
      model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high",
    };
    const response = { version: 1, requestId: "request", ok: true, result };
    expect(parseDaemonResponse(response)).toEqual(response);
    expect(() => parseDaemonResponse({ ...response, result: { ...result, unknown: true } })).toThrow(/unknown/i);
    expect(() => parseDaemonResponse({ ...response, result: { ...result, commands: [{ name: "/x", source: "invented" }] } })).toThrow(/source/i);
  });

  it("parses the summary settings result and a bounded session summary", () => {
    const settings = { version: 1, requestId: "request", ok: true, result: { kind: "settings", summaryModel: { provider: "anthropic", id: "haiku" } } };
    expect(parseDaemonResponse(settings)).toEqual(settings);
    expect(parseDaemonResponse({ ...settings, result: { kind: "settings", summaryModel: null } })).toBeTruthy();
    const session = { schemaVersion: 1, revision: 1, sessionId: "s", sessionFile: "/s.jsonl", canonicalSessionFile: "/s.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "idle", summary: "Idle", updatedAt: "2026-01-01T00:00:00.000Z" }, summary: { text: "Refactored the loader and ran tests", generatedAt: "2026-01-01T00:00:00.000Z", model: { provider: "anthropic", id: "haiku" }, sourceCursor: "42" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(parseDaemonResponse({ version: 1, requestId: "request", ok: true, result: { kind: "state", sessions: [session] } })).toBeTruthy();
    expect(() => parseDaemonResponse({ version: 1, requestId: "request", ok: true, result: { kind: "state", sessions: [{ ...session, summary: { ...session.summary, text: "" } }] } })).toThrow(/summary.text/);
  });

  it("strictly parses daemon failures", () => {
    const response = { version: 1, requestId: "request", ok: false, error: { code: "DENIED", message: "denied", retryable: false } };
    expect(parseDaemonResponse(response)).toEqual(response);
    expect(() => parseDaemonResponse({ ...response, unknown: true })).toThrow(/unknown/i);
  });
});
