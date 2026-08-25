import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../../shared/contracts.js";
import {
  createDeliveryUnknownOverlay,
  createHelpOverlay,
  createMetadataOverlay,
  createSessionIntent,
  createSharedDirectoryOverlay,
} from "./dashboard-overlays.js";

const session: SessionRecord = {
  schemaVersion: 1,
  revision: 2,
  sessionId: "session-1",
  sessionFile: "/sessions/session-1.jsonl",
  canonicalSessionFile: "/sessions/session-1.jsonl",
  cwd: "/repo",
  model: { provider: "anthropic", id: "claude" },
  thinkingLevel: "high",
  taskState: "READY",
  processState: "LIVE",
  outcome: "READY_FOR_REVIEW",
  activity: { kind: "assistant_final", summary: "Ready for review", updatedAt: "2026-08-25T12:00:00.000Z" },
  createdAt: "2026-08-25T11:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z",
};

describe("dashboard overlays", () => {
  it("keeps task, process, outcome, and activity independent in metadata", () => {
    expect(createMetadataOverlay(session)).toMatchObject({
      kind: "metadata",
      sessionId: "session-1",
      fields: {
        taskState: "READY",
        processState: "LIVE",
        outcome: "READY_FOR_REVIEW",
        activity: "Ready for review",
      },
    });
  });

  it("returns typed help and exact-path shared warning surfaces", () => {
    expect(createHelpOverlay().kind).toBe("help");
    expect(createSharedDirectoryOverlay("/canonical/repo", ["a", "b"])).toEqual({
      kind: "shared_directory_confirmation",
      canonicalCwd: "/canonical/repo",
      ownerSessionIds: ["a", "b"],
      requiredInput: "/canonical/repo",
    });
  });

  it("routes Ctrl+X to a non-destructive Task 15 intent seam", () => {
    expect(createSessionIntent(session)).toEqual({ kind: "session_intent", action: "stop", sessionId: "session-1", revision: 2 });
    expect(createSessionIntent({ ...session, processState: "EXITED" })).toEqual({ kind: "session_intent", action: "delete", sessionId: "session-1", revision: 2 });
  });

  it("offers only explicit DELIVERY_UNKNOWN resolution actions", () => {
    expect(createDeliveryUnknownOverlay("client", "request")).toEqual({
      kind: "delivery_unknown",
      clientId: "client",
      requestId: "request",
      actions: ["retry_at_risk", "abandon"],
    });
  });
});
