import { expect, it, vi } from "vitest";

import { runSessionCommand } from "./session-commands.mjs";

const inactive = {
  sessionId: "exact-session-id",
  revision: 4,
  processState: "EXITED",
  isolation: { mode: "worktree", worktreePath: "/managed/worktree", branch: "agent/exact" },
};

it("requires exact ID, revision, and confirmation for stop and delete", async () => {
  const request = vi.fn();
  await expect(runSessionCommand(["stop", "exact-session-id", "--revision", "4"], { request })).resolves.toMatchObject({ code: 2 });
  await expect(runSessionCommand(["stop", "exact-session-id", "--revision", "4", "--yes"], { request })).resolves.toMatchObject({ code: 0 });
  expect(request).toHaveBeenCalledWith("stop", { sessionId: "exact-session-id", revision: 4 });
});

it("keeps worktree cleanup separate and supplies an authoritative ownership reader", async () => {
  const request = vi.fn(async (op) => op === "get_state" ? { kind: "state", sessions: [inactive] } : undefined);
  const cleanupManagedWorktree = vi.fn(async (_record, options) => {
    expect(await options.readLiveOwnership()).toBeNull();
    return { disposition: "REMOVED" };
  });

  await expect(runSessionCommand(["cleanup", "exact-session-id", "--revision", "4", "--yes"], {
    request,
    cleanupManagedWorktree,
  })).resolves.toMatchObject({ code: 0, result: { disposition: "REMOVED" } });
  expect(cleanupManagedWorktree).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalledWith("delete", expect.anything());
});

it("refuses cleanup when revision changes or live ownership appears", async () => {
  const changed = { ...inactive, revision: 5, processState: "LIVE", ownership: { runId: "late" } };
  const request = vi.fn(async () => ({ kind: "state", sessions: [changed] }));
  const cleanupManagedWorktree = vi.fn();

  await expect(runSessionCommand(["cleanup", "exact-session-id", "--revision", "4", "--yes"], {
    request,
    cleanupManagedWorktree,
  })).resolves.toMatchObject({ code: 1, error: { code: "REVISION_CONFLICT" } });
  expect(cleanupManagedWorktree).not.toHaveBeenCalled();
});

it("does not automatically retry an ambiguous destructive command", async () => {
  const request = vi.fn(async () => ({ kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli", requestId: "delete-1" } }));
  await expect(runSessionCommand(["delete", "exact-session-id", "--revision", "4", "--yes"], { request })).resolves.toMatchObject({
    code: 1,
    error: { code: "DELIVERY_UNKNOWN" },
  });
  expect(request).toHaveBeenCalledTimes(1);
});
