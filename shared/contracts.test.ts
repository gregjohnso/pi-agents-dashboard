import { describe, expect, it } from "vitest";

import {
  parseClientRequest,
  type ClientRequest,
  type SessionRecord,
} from "./contracts.js";

const envelope = {
  version: 1,
  clientId: "client-1",
  requestId: "request-1",
} as const;

describe("parseClientRequest", () => {
  it("accepts every operation with its exact structured payload", () => {
    const requests: readonly ClientRequest[] = [
      { ...envelope, op: "get_state", payload: {} },
      {
        ...envelope,
        op: "launch",
        payload: {
          prompt: "Run the tests",
          cwd: "/repo",
          sourceSessionId: "source-1",
          isolation: { mode: "worktree" },
          model: { provider: "provider", id: "model" },
          thinkingLevel: "high",
          name: "tests",
        },
      },
      {
        ...envelope,
        op: "launch",
        payload: {
          prompt: "Run the tests",
          cwd: "/repo",
          sourceSessionId: "source-1",
          isolation: { mode: "shared_directory", confirmedCwd: "/repo" },
        },
      },
      { ...envelope, op: "attach", payload: { sessionId: "session-1", role: "composer" } },
      { ...envelope, op: "attach", payload: { sessionId: "session-1", role: "observer" } },
      { ...envelope, op: "detach", payload: { sessionId: "session-1" } },
      { ...envelope, op: "prompt", payload: { sessionId: "session-1", text: "next" } },
      { ...envelope, op: "steer", payload: { sessionId: "session-1", text: "change course" } },
      { ...envelope, op: "follow_up", payload: { sessionId: "session-1", text: "also check" } },
      { ...envelope, op: "interrupt", payload: { sessionId: "session-1" } },
      { ...envelope, op: "stop", payload: { sessionId: "session-1", revision: 7 } },
      { ...envelope, op: "delete", payload: { sessionId: "session-1", revision: 7 } },
      {
        ...envelope,
        op: "ui_response",
        payload: { sessionId: "session-1", uiRequestId: "ui-1", response: { answer: true } },
      },
      { ...envelope, op: "subscribe", payload: {} },
      {
        ...envelope,
        op: "subscribe",
        payload: { after: { daemonEpoch: "epoch-1", sequence: "42" } },
      },
      {
        ...envelope,
        op: "ack",
        payload: { cursor: { daemonEpoch: "epoch-1", sequence: "42" } },
      },
      {
        ...envelope,
        op: "resolve_delivery",
        payload: {
          targetClientId: "client-1",
          targetRequestId: "uncertain-request",
          resolution: "retry_at_risk",
        },
      },
      {
        ...envelope,
        op: "resolve_delivery",
        payload: {
          targetClientId: "client-1",
          targetRequestId: "uncertain-request",
          resolution: "abandon",
        },
      },
    ];

    expect(requests.map((request) => parseClientRequest(request))).toEqual(requests);
  });

  it("rejects unknown operations and requires exact envelope IDs", () => {
    expect(() =>
      parseClientRequest({ ...envelope, op: "shell", payload: {} }),
    ).toThrowError(/operation/i);
    expect(() =>
      parseClientRequest({ version: 1, requestId: "request-1", op: "get_state", payload: {} }),
    ).toThrowError(/clientId/);
    expect(() =>
      parseClientRequest({ version: 1, clientId: "client-1", op: "get_state", payload: {} }),
    ).toThrowError(/requestId/);
    expect(() =>
      parseClientRequest({ ...envelope, requestId: "", op: "get_state", payload: {} }),
    ).toThrowError(/requestId/);
  });

  it("fails closed on unknown fields, including destructive target fields", () => {
    expect(() =>
      parseClientRequest({
        ...envelope,
        op: "stop",
        payload: { sessionId: "session-1", revision: 7, processGroupId: 1234 },
      }),
    ).toThrowError(/processGroupId/);
    expect(() =>
      parseClientRequest({
        ...envelope,
        op: "delete",
        payload: { sessionId: "session-1", revision: 7, sessionFile: "/tmp/session.jsonl" },
      }),
    ).toThrowError(/sessionFile/);
    expect(() =>
      parseClientRequest({ ...envelope, op: "get_state", payload: {}, extra: true }),
    ).toThrowError(/extra/);
    expect(() =>
      parseClientRequest({ ...envelope, op: "get_state", payload: { sessionId: "session-1" } }),
    ).toThrowError(/sessionId/);
  });

  it("rejects missing or invalid operation payload fields", () => {
    expect(() =>
      parseClientRequest({ ...envelope, op: "attach", payload: { sessionId: "session-1" } }),
    ).toThrowError(/role/);
    expect(() =>
      parseClientRequest({ ...envelope, op: "stop", payload: { sessionId: "session-1" } }),
    ).toThrowError(/revision/);
    expect(() =>
      parseClientRequest({
        ...envelope,
        op: "resolve_delivery",
        payload: {
          targetClientId: "client-1",
          targetRequestId: "uncertain-request",
          resolution: "retry",
        },
      }),
    ).toThrowError(/resolution/);
    expect(() =>
      parseClientRequest({
        ...envelope,
        op: "launch",
        payload: {
          prompt: "Run the tests",
          cwd: "/repo",
          sourceSessionId: "source-1",
          piConfigRoot: "/untrusted",
          isolation: { mode: "worktree" },
        },
      }),
    ).toThrowError(/piConfigRoot/);
  });
});

describe("SessionRecord", () => {
  it("keeps task, process, outcome, and activity as separate dimensions", () => {
    const session: SessionRecord = {
      schemaVersion: 1,
      revision: 1,
      sessionId: "session-1",
      sessionFile: "/sessions/session-1.jsonl",
      canonicalSessionFile: "/sessions/session-1.jsonl",
      cwd: "/repo",
      taskState: "READY",
      processState: "SLEEPING",
      outcome: "READY_FOR_REVIEW",
      activity: { kind: "assistant", summary: "Ready for review", updatedAt: "2026-08-25T00:00:00Z" },
      createdAt: "2026-08-25T00:00:00Z",
      updatedAt: "2026-08-25T00:00:00Z",
    };

    expect(session).toMatchObject({
      taskState: "READY",
      processState: "SLEEPING",
      outcome: "READY_FOR_REVIEW",
      activity: { kind: "assistant" },
    });
  });
});
