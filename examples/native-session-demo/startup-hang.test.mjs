/**
 * Startup must not be hostage to one silent owner.
 *
 * `ask()` settled only on an expected frame, a refusal, a parse error, a socket error or a close. A listening
 * socket whose process never replies and never closes satisfies none of those, so the probe never settled. The
 * whole chain is unbounded from there: `getState` awaits `Promise.all` over EVERY session directory, and the
 * standalone list awaited `controller.open()` BEFORE starting its TUI - so one wedged peer left a blank terminal
 * sitting in `epoll_wait` with no list, no error and nothing to quit.
 *
 * A wedged process is enough to produce this: the listen backlog lives in the kernel, so `connect` succeeds and
 * the writes land in a buffer even when nothing ever calls `accept`.
 *
 * What a timeout is allowed to mean is the other half of this. It means unreachable - which this backend already
 * renders as STALE - and never EXITED or STOPPED, because nobody observed an exit. Mutations keep their own, far
 * more generous, deadlines: a stop previously needed about eight seconds and a rename receipt about five, so a
 * status bound must never be applied to them.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MUTATION_ANSWER_MS,
  STATUS_PROBE_MS,
  createNativeBackend,
  probeControl,
} from "../../app/list/native-backend.mjs";
import { demoPaths } from "./demo-root.mjs";
import { createFrameReader, encodeFrame } from "./protocol.mjs";
import { displaySessionState } from "../../app/list/session-state.mjs";

/** @type {(() => unknown)[]} */
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/**
 * One session root served by a peer that behaves however the case needs.
 *
 * `behaviour`:
 *   "silent"  accepts and never writes, never closes - the wedged manager this file is about
 *   "healthy" answers the status frame properly
 *   "error"   refuses the connection (no listener at all, stale socket file)
 *   "close"   accepts then immediately closes without answering
 */
async function peerRoot(sessionsHome, sessionId, behaviour, { onConnect } = {}) {
  const root = join(sessionsHome, sessionId);
  await mkdir(root, { recursive: true });
  const paths = demoPaths(root);
  await writeFile(paths.token, "startup-fixture-token\n");
  if (behaviour === "error") {
    // A socket path that exists but has no listener behind it: `connect` fails, which must still settle.
    await writeFile(paths.controlSocket, "");
    return { root, connections: () => 0 };
  }
  let connections = 0;
  /** @type {Set<net.Socket>} */
  const accepted = new Set();
  const server = net.createServer((socket) => {
    connections += 1;
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => {});
    onConnect?.();
    if (behaviour === "close") {
      socket.destroy();
      return;
    }
    if (behaviour === "silent") return;
    const reader = createFrameReader(
      ({ header }) => {
        if (header?.type !== "status") return;
        socket.write(encodeFrame({
          type: "status",
          status: {
            root,
            owner: { pid: process.pid, startIdentity: `identity-${sessionId}` },
            geometry: { cols: 181, rows: 79 },
            geometryRevision: 1,
            attachments: [],
            exit: null,
            reaped: null,
            projectCwd: root,
            readiness: [{ phase: "native-mounted" }],
            presentations: [],
            bridge: { connected: true, facts: { agentPhase: "settled", idle: true, pendingMessages: false } },
          },
        }));
      },
      () => socket.destroy(),
    );
    socket.on("data", (chunk) => reader.push(chunk));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.controlSocket, () => resolve(undefined));
  });
  cleanup.push(async () => {
    for (const socket of [...accepted]) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });
  return { root, connections: () => connections };
}

async function sessionsRoot() {
  const base = join(tmpdir(), "x").length + 24 <= 100 || !existsSync("/tmp") ? tmpdir() : "/tmp";
  const home = await mkdtemp(join(base, "pia-hang-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

describe("a control probe is bounded on every outcome", () => {
  it("gives up on a socket that accepts and never answers, instead of hanging forever", async () => {
    const home = await sessionsRoot();
    const { root } = await peerRoot(home, "session-1700000000001", "silent");
    const startedAt = Date.now();
    const probe = await probeControl(root, { type: "status" }, "status", { timeoutMs: 300 });
    const elapsed = Date.now() - startedAt;
    expect(probe.reachable).toBe(false);
    expect(probe.reason).toMatch(/did not answer/iu);
    // Bounded, and bounded by the deadline it was given rather than by luck.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(4_000);
  });

  it("still settles on a connection error and on an early close", async () => {
    const home = await sessionsRoot();
    const broken = await peerRoot(home, "session-1700000000002", "error");
    const closing = await peerRoot(home, "session-1700000000003", "close");
    const first = await probeControl(broken.root, { type: "status" }, "status", { timeoutMs: 5_000 });
    const second = await probeControl(closing.root, { type: "status" }, "status", { timeoutMs: 5_000 });
    expect(first.reachable).toBe(false);
    expect(second.reachable).toBe(false);
    // Neither reason may be the timeout: both peers gave a real answer about themselves. Which one a closing peer
    // produces is a race between the write and the destroy, so either the close or the broken pipe is correct.
    expect(first.reason).not.toMatch(/did not answer/iu);
    expect(second.reason).not.toMatch(/did not answer/iu);
    expect(second.reason).toMatch(/closed before answering|EPIPE|ECONNRESET/u);
  });

  it("leaves no timer holding the event loop open after it settles", async () => {
    const home = await sessionsRoot();
    const { root } = await peerRoot(home, "session-1700000000004", "healthy");
    const probe = await probeControl(root, { type: "status" }, "status", { timeoutMs: 60_000 });
    expect(probe.reachable).toBe(true);
    // A 60s timer that outlived a fast answer would keep this process alive; an unref'd or cleared one does not.
    const handles = process.getActiveResourcesInfo?.().filter((name) => name === "Timeout") ?? [];
    expect(handles.length).toBeLessThan(8);
  });

  it("keeps a status bound short and a mutation bound generous", () => {
    // The two are different questions. Stop previously needed about 8s and a rename receipt about 5s, so the
    // fast bound that makes first paint possible must never be the one applied to them.
    expect(STATUS_PROBE_MS).toBeLessThanOrEqual(5_000);
    expect(MUTATION_ANSWER_MS).toBeGreaterThanOrEqual(15_000);
  });
});

describe("one silent owner does not hide the healthy ones", () => {
  it("lists a healthy row beside a silent peer, and calls the silent one stale rather than exited", async () => {
    const home = await sessionsRoot();
    await peerRoot(home, "session-1700000000010", "healthy");
    await peerRoot(home, "session-1700000000011", "silent");
    const client = createNativeBackend({ sessionsHome: home, listModels: async () => "provider  model", statusTimeoutMs: 400 });

    const startedAt = Date.now();
    const { sessions } = await client.getState();
    const elapsed = Date.now() - startedAt;

    expect(sessions).toHaveLength(2);
    const healthy = sessions.find((row) => row.sessionId === "session-1700000000010");
    const silent = sessions.find((row) => row.sessionId === "session-1700000000011");
    // The healthy owner is fully loaded, not degraded by its neighbour.
    expect(healthy.processState).toBe("LIVE");
    expect(healthy.taskState).toBe("READY");
    // A peer that did not answer is unreachable: STALE, and never a claimed death.
    expect(silent.processState).toBe("STALE");
    expect(silent.taskState).not.toBe("STOPPED");
    expect(silent.taskState).not.toBe("FAILED");
    expect(displaySessionState(silent)).toBe("STALE");
    expect(displaySessionState(silent)).not.toBe("EXITED");
    expect(silent.activity.summary).toMatch(/could not be reached/u);
    expect(elapsed).toBeLessThan(6_000);
    client.close();
  });

  it("asks each session exactly once per read, with no retry storm", async () => {
    const home = await sessionsRoot();
    const silent = await peerRoot(home, "session-1700000000020", "silent");
    const client = createNativeBackend({ sessionsHome: home, listModels: async () => "provider  model", statusTimeoutMs: 250 });
    await client.getState();
    expect(silent.connections()).toBe(1);
    await client.getState();
    expect(silent.connections()).toBe(2);
    client.close();
  });
});
