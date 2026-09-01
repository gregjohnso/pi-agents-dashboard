import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

import * as launchResolver from "./launch-resolver.mjs";

const { createLaunchResolver } = launchResolver;

it("materializes and validates a real Pi session header before launch", async () => {
  expect(launchResolver.materializePiSession).toBeTypeOf("function");
  const root = await mkdtemp(join(tmpdir(), "pi-agents-materialized-session-"));
  const cwd = join(root, "cwd");
  const sessions = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(sessions)]);
  try {
    const created = await launchResolver.materializePiSession(cwd, "prepared-id", {
      createManager: (/** @type {string} */ managerCwd, /** @type {string} */ sessionId) => SessionManager.create(managerCwd, sessions, { id: sessionId }),
      openSession: (/** @type {string} */ path, /** @type {string} */ managerCwd) => SessionManager.open(path, sessions, managerCwd),
    });
    const header = JSON.parse((await readFile(created.sessionFile, "utf8")).trim().split("\n")[0]);
    expect(header).toMatchObject({ type: "session", id: created.sessionId, cwd });
    expect((await stat(created.sessionFile)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A launch that fails before its child exists is marked FAILED by the daemon, never rolled back, so
// the resolver offers no rollback entry point.
it("resolves launches and materializes sessions, and offers no rollback", async () => {
  expect(Object.keys(launchResolver).sort()).toEqual(["createLaunchResolver", "materializePiSession", "sessionNameFromPrompt"]);
});

it("names a session from its initial prompt and keeps an explicit name", async () => {
  const launch = (/** @type {any} */ payload) => createLaunchResolver({
    registry: { list: vi.fn(async () => []) },
    piConfigRoot: "/pi/agent",
    preflight: vi.fn(async () => ({ mode: "shared_directory_confirmation", canonicalCwd: "/repo", confirmedCanonicalCwd: "/repo", ownerSessionIds: [], piConfigRoot: "/pi/agent" })),
    createWorktree: vi.fn(),
    confirmSharedDirectory: vi.fn(async () => ({ mode: "shared_directory", canonicalCwd: "/repo", workerCwd: "/repo", sourceSessionId: "source", piConfigRoot: "/pi/agent" })),
    createPiSession: vi.fn(() => ({ sessionId: "named-session", sessionFile: "/pi/agent/sessions/named-session.jsonl" })),
    canonicalizeCwd: async (/** @type {string} */ cwd) => cwd,
    randomId: () => "prepared",
    now: () => "2026-08-25T12:00:00.000Z",
  })({ payload });

  const base = { cwd: "/repo", sourceSessionId: "source", isolation: { mode: "shared_directory", confirmedCwd: "/repo", ownerSessionIds: [] } };
  const derived = await launch({ ...base, prompt: "  Fix   the coverage loader\nand rerun the tests  " });
  expect(derived.sessionRecord).toMatchObject({ name: "Fix the coverage loader", nameGenerated: true });
  expect(derived.name).toBe("Fix the coverage loader");

  const explicit = await launch({ ...base, prompt: "Fix the loader", name: "Chosen name" });
  expect(explicit.sessionRecord).toMatchObject({ name: "Chosen name", nameGenerated: false });
});

it("removes a prepared worktree when later session preparation fails", async () => {
  const cleanupWorktree = vi.fn(async () => ({ disposition: "REMOVED" }));
  const createWorktree = vi.fn(async () => ({ mode: "worktree", worktreePath: "/worktree", branch: "pi-agents/prepared", workerCwd: "/worktree" }));
  const resolveLaunch = createLaunchResolver({
    registry: { list: vi.fn(async () => []) },
    piConfigRoot: "/pi/agent",
    preflight: async () => ({ mode: "worktree" }),
    createWorktree,
    cleanupWorktree,
    createPiSession: async () => { throw new Error("session preparation failed"); },
    canonicalizeCwd: async (/** @type {string} */ cwd) => cwd,
    randomId: vi.fn().mockReturnValueOnce("prepared").mockReturnValueOnce("run"),
  });

  await expect(resolveLaunch({ payload: { prompt: "hello", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" } } })).rejects.toThrow("session preparation failed");
  expect(cleanupWorktree).toHaveBeenCalledWith({ mode: "worktree", worktreePath: "/worktree", branch: "pi-agents/prepared", workerCwd: "/worktree" }, { readLiveOwnership: expect.any(Function) });
});

it("builds an isolated canonical session launch from the daemon request", async () => {

  const registry = { list: vi.fn(async () => []) };
  const preflight = vi.fn(async () => ({
    mode: "worktree",
    canonicalCwd: "/repo",
    repositoryRoot: "/repo",
    sourceSubdirectory: "packages/app",
    baseCommit: "a".repeat(40),
    sourceBranch: "main",
    sourceDirty: false,
    sourceSessionId: "dashboard-client",
    piConfigRoot: "/pi/agent",
    worktreesRoot: "/pi/agent/pi-agents/worktrees",
  }));
  const createWorktree = vi.fn(async () => ({
    mode: "worktree",
    worktreePath: "/pi/agent/pi-agents/worktrees/session-id",
    branch: "pi-agents/session-id",
    workerCwd: "/pi/agent/pi-agents/worktrees/session-id/packages/app",
  }));
  // Pi reports the materialized file's identity; nothing downstream of resolution consumes it, so
  // it must not reach the launch the daemon hands to the supervisor.
  const createPiSession = vi.fn(() => ({ sessionId: "session-id", sessionFile: "/pi/agent/sessions/project/session-id.jsonl", identity: { dev: 1, ino: 2, size: 3, mtimeMs: 4 } }));
  const ids = ["session-id", "run-id"];
  const preparedRunHash = createHash("sha256").update("run-id\0session-id").digest("hex");
  const resolveLaunch = createLaunchResolver({
    registry,
    piConfigRoot: "/pi/agent",
    preflight,
    createWorktree,
    confirmSharedDirectory: vi.fn(),
    createPiSession,
    canonicalizeCwd: async (/** @type {string} */ cwd) => cwd,
    randomId: () => ids.shift(),
    now: () => "2026-08-25T12:00:00.000Z",
  });
  const request = {
    clientId: "frontend",
    requestId: "launch",
    payload: {
      prompt: "who are you?",
      cwd: "/repo/packages/app",
      sourceSessionId: "dashboard-client",
      isolation: { mode: "worktree" },
      model: { provider: "openai", id: "gpt" },
      // The wire refuses this field now; a payload that still carries one reaches neither Pi nor the record.
      thinkingLevel: "high",
      name: "identity",
    },
  };

  const resolved = await resolveLaunch(request);
  expect(resolved).toEqual({
    sessionId: "session-id",
    canonicalSessionFile: "/pi/agent/sessions/project/session-id.jsonl",
    cwd: "/pi/agent/pi-agents/worktrees/session-id/packages/app",
    runId: "run-id",
    runHash: preparedRunHash,
    initialPrompt: "who are you?",
    model: { provider: "openai", id: "gpt" },
    name: "identity",
    sessionRecord: {
      schemaVersion: 1,
      revision: 0,
      sessionId: "session-id",
      sessionFile: "/pi/agent/sessions/project/session-id.jsonl",
      canonicalSessionFile: "/pi/agent/sessions/project/session-id.jsonl",
      cwd: "/pi/agent/pi-agents/worktrees/session-id/packages/app",
      name: "identity",
      nameGenerated: false,
      taskState: "READY",
      processState: "EXITED",
      outcome: "NONE",
      activity: { kind: "launching", summary: "who are you?", updatedAt: "2026-08-25T12:00:00.000Z" },
      isolation: { mode: "worktree", worktreePath: "/pi/agent/pi-agents/worktrees/session-id", branch: "pi-agents/session-id" },
      // The run directory is named before spawn and is relative to whatever state root holds the row.
      latestRunId: "run-id",
      runHash: preparedRunHash,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    },
  });
  // The requested model reaches Pi through the worker's arguments and never the prepared row: a
  // launch that dies before Pi starts must not display a model it never ran.
  expect(resolved.sessionRecord).not.toHaveProperty("model");
  expect(resolved.model).toEqual({ provider: "openai", id: "gpt" });
  expect(preparedRunHash).not.toContain("/");
  expect(preflight).toHaveBeenCalledWith(request.payload, { piConfigRoot: "/pi/agent", currentOwnerSessionIds: [] });
  expect(createWorktree).toHaveBeenCalledWith(expect.any(Object), { worktreeId: "session-id" });
  expect(createPiSession).toHaveBeenCalledWith("/pi/agent/pi-agents/worktrees/session-id/packages/app", "session-id");
});

it("rejects a shared-directory launch when owners changed after frontend confirmation", async () => {
  const changedOwner = { sessionId: "changed", cwd: "/repo", ownership: { runId: "run" }, isolation: { mode: "shared_directory", canonicalCwd: "/repo" } };
  const registry = { list: vi.fn(async () => [changedOwner]) };
  const resolveLaunch = createLaunchResolver({
    registry,
    piConfigRoot: "/pi/agent",
    preflight: async (/** @type {any} */ payload) => {
      expect(payload.isolation.ownerSessionIds).toEqual(["owner"]);
      return { mode: "shared_directory_confirmation", canonicalCwd: "/repo", confirmedCanonicalCwd: "/repo", ownerSessionIds: ["owner"], sourceSessionId: "source", piConfigRoot: "/pi/agent" };
    },
    createWorktree: vi.fn(),
    createPiSession: () => ({ sessionId: "session", sessionFile: "/sessions/session.jsonl" }),
    canonicalizeCwd: async (/** @type {string} */ cwd) => cwd,
    randomId: vi.fn().mockReturnValueOnce("session").mockReturnValueOnce("run"),
  });

  await expect(resolveLaunch({ payload: { prompt: "hello", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "shared_directory", confirmedCwd: "/repo", ownerSessionIds: ["owner"] } } })).rejects.toMatchObject({ code: "OWNERS_CHANGED" });
  expect(registry.list).toHaveBeenCalledOnce();
});
