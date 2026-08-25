import net from "node:net";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { cleanupManagedWorktree as defaultCleanupManagedWorktree } from "../isolation/cleanup.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";

/** @param {unknown} value */
function exactSessionId(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !value.includes("/") && !value.includes("\0") && value !== "." && value !== "..";
}

function runtimeRoot(env = process.env) {
  const home = env.HOME ?? homedir();
  return resolve(env.PI_AGENTS_DASHBOARD_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-agents-dashboard"));
}

/** Create one authenticated request per CLI operation; closing it never signals workers. */
export function createDaemonRequester({ root = runtimeRoot(), clientId = `cli-${randomUUID()}`, maxBytes = 1024 * 1024 } = {}) {
  return async (op, payload, requestId = randomUUID()) => {
    const token = (await readFile(join(root, "daemon", "control.token"), "utf8")).trim();
    const encoder = createJsonlEncoder({ maxBytes });
    const decoder = createJsonlDecoder({ maxBytes });
    return new Promise((resolveRequest, rejectRequest) => {
      const socket = net.createConnection(join(root, "daemon", "control.sock"));
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error !== undefined) rejectRequest(error);
        else resolveRequest(value);
      };
      socket.once("connect", () => socket.write(encoder.encode({ version: 1, token })));
      socket.once("error", (error) => finish(error));
      socket.on("data", (chunk) => {
        try {
          for (const frame of decoder.push(chunk)) {
            if (frame?.kind === "authenticated") socket.write(encoder.encode({ version: 1, clientId, requestId, op, payload }));
            else if (frame?.requestId === requestId) {
              if (!frame.ok) finish(Object.assign(new Error(frame.error?.message ?? "Daemon request failed"), frame.error));
              else finish(undefined, frame.result);
            }
          }
        } catch (error) {
          finish(error);
        }
      });
    });
  };
}

/** @param {string[]} argv */
function parse(argv) {
  const [command, sessionId, ...flags] = argv;
  if (!["status", "stop", "delete", "cleanup"].includes(command) || !exactSessionId(sessionId)) {
    return { error: "Usage: session status <full-id> | session stop|delete|cleanup <full-id> --revision <n> --yes" };
  }
  if (command === "status") return flags.length === 0 ? { command, sessionId } : { error: "Status accepts no flags" };
  const revisionIndex = flags.indexOf("--revision");
  const revision = revisionIndex < 0 ? undefined : Number(flags[revisionIndex + 1]);
  const allowed = new Set(["--revision", flags[revisionIndex + 1], "--yes"]);
  if (!flags.includes("--yes") || !Number.isSafeInteger(revision) || revision < 0 || flags.some((flag) => !allowed.has(flag))) {
    return { error: "Destructive session commands require --revision <non-negative integer> --yes" };
  }
  return { command, sessionId, revision };
}

/** @param {any} result */
function classifyCommandResult(result) {
  if (result?.kind === "command" && result.status?.stage === "DELIVERY_UNKNOWN") {
    return { code: 1, error: { code: "DELIVERY_UNKNOWN", message: "Delivery is ambiguous; use explicit retry_at_risk or abandon" }, result };
  }
  if (result?.kind === "command" && result.status?.stage === "FAILED") {
    return { code: 1, error: result.status.error ?? { code: "COMMAND_FAILED", message: "Command failed" }, result };
  }
  return { code: 0, result };
}

/**
 * Run an exact-ID session command. The request seam is the authenticated daemon client.
 *
 * @param {string[]} argv
 * @param {{ request?: (op: string, payload: any, requestId?: string) => Promise<any>, cleanupManagedWorktree?: typeof defaultCleanupManagedWorktree, root?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export async function runSessionCommand(argv, options = {}) {
  const parsed = parse(argv);
  if ("error" in parsed) return { code: 2, error: { code: "INVALID_SYNTAX", message: parsed.error } };
  const request = options.request ?? createDaemonRequester({ root: options.root ?? runtimeRoot(options.env) });

  if (parsed.command === "status") {
    const state = await request("get_state", {});
    const session = state?.sessions?.find((candidate) => candidate.sessionId === parsed.sessionId);
    return session === undefined
      ? { code: 1, error: { code: "SESSION_NOT_FOUND", message: `Unknown exact session ID: ${parsed.sessionId}` } }
      : { code: 0, result: { kind: "session_status", session } };
  }

  if (parsed.command === "stop" || parsed.command === "delete") {
    return classifyCommandResult(await request(parsed.command, {
      sessionId: parsed.sessionId,
      revision: parsed.revision,
    }));
  }

  const readSession = async () => {
    const state = await request("get_state", {});
    return state?.sessions?.find((candidate) => candidate.sessionId === parsed.sessionId);
  };
  const session = await readSession();
  if (session === undefined) return { code: 1, error: { code: "SESSION_NOT_FOUND", message: `Unknown exact session ID: ${parsed.sessionId}` } };
  if (session.revision !== parsed.revision) return { code: 1, error: { code: "REVISION_CONFLICT", message: "Session revision changed before cleanup" } };
  if (session.isolation?.mode !== "worktree") return { code: 1, error: { code: "NOT_MANAGED_WORKTREE", message: "Shared-directory sessions have no managed worktree to remove" } };

  try {
    const cleanupManagedWorktree = options.cleanupManagedWorktree ?? defaultCleanupManagedWorktree;
    const result = await cleanupManagedWorktree(session.isolation, {
      readLiveOwnership: async () => {
        const current = await readSession();
        if (current === undefined || current.revision !== parsed.revision || current.ownership !== undefined || ["LIVE", "SLEEPING"].includes(current.processState)) {
          return { conflict: true };
        }
        return null;
      },
    });
    return { code: 0, result };
  } catch (error) {
    return { code: ["OWNERSHIP_CONFLICT", "IDENTITY_MISMATCH"].includes(error?.code) ? 5 : 1, error: { code: error?.code ?? "CLEANUP_FAILED", message: error instanceof Error ? error.message : "Cleanup failed" } };
  }
}
