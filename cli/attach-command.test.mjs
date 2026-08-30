import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { attachSession } from "./attach-command.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function stateRoot() {
  const root = await mkdtemp(join(tmpdir(), "dashboard-attach-state-"));
  roots.push(root);
  return root;
}

/** Record the attach, viewer, and detach calls one attachment makes, in order. */
function connection(events, { attach = async () => ({ kind: "attached" }), open = async () => {} } = {}) {
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const viewer = {
    closed,
    open: vi.fn(async () => { events.push("open"); await open(); resolveClosed(); }),
    close: vi.fn(async () => { events.push("close"); resolveClosed(); }),
  };
  const connect = vi.fn(async () => ({
    viewerClient: {
      attach: vi.fn(async (sessionId) => { events.push(`attach:${sessionId}`); return attach(); }),
      detach: vi.fn(async (sessionId) => { events.push(`detach:${sessionId}`); }),
    },
    createViewer: () => { events.push("create"); return viewer; },
    close: vi.fn(async () => { events.push("disconnect"); }),
  }));
  return { connect, viewer };
}

it("attaches, opens one viewer, and releases the session when the operator returns", async () => {
  const root = await stateRoot();
  const events = [];
  const { connect } = connection(events);
  await expect(attachSession("exact-session-id", { root, randomId: () => "stable", connect })).resolves.toEqual({ code: 0, result: { kind: "detached", sessionId: "exact-session-id" } });
  expect(events).toEqual(["attach:exact-session-id", "create", "open", "close", "detach:exact-session-id", "disconnect"]);
  expect(connect).toHaveBeenCalledWith({ root, clientId: "cli-stable", sessionId: "exact-session-id" });
});

it("reports a refused attachment without opening a viewer", async () => {
  const root = await stateRoot();
  const events = [];
  const { connect } = connection(events, { attach: async () => { throw Object.assign(new Error("Session does not exist"), { code: "SESSION_NOT_FOUND" }); } });
  await expect(attachSession("missing-session-id", { root, randomId: () => "stable", connect })).resolves.toMatchObject({ code: 1, error: { code: "SESSION_NOT_FOUND" } });
  expect(events).toEqual(["attach:missing-session-id", "disconnect"]);
});

it.each([
  ["path-like", "sessions/exact-session-id"],
  ["empty", ""],
])("rejects a %s session identifier before connecting", async (_name, sessionId) => {
  const connect = vi.fn();
  await expect(attachSession(sessionId, { connect })).resolves.toMatchObject({ code: 2, error: { code: "INVALID_SYNTAX" } });
  expect(connect).not.toHaveBeenCalled();
});
