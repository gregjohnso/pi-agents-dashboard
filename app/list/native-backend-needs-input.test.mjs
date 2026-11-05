import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { createNativeBackend } from "./native-backend.mjs";
import { displaySessionState } from "./session-state.mjs";

const OWNER = { pid: process.pid, startIdentity: "12345", processGroupId: process.pid };
const WORKING = { agentPhase: "start", idle: false };
const READY = { agentPhase: "settled", idle: true };
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** One live session whose reported phase the case sets between reads. */
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "pia-needs-input-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const sessionsHome = path.join(dir, "runtime");
  const stateHome = path.join(dir, "state");
  const root = path.join(sessionsHome, "session-1700000000041");
  await mkdir(root, { recursive: true });
  const session = { facts: WORKING };
  const control = async () => ({ reachable: true, answer: { status: { root, owner: OWNER, bridge: { connected: true, facts: session.facts }, projectCwd: dir, exit: null } } });
  const client = () => {
    const backend = createNativeBackend({ sessionsHome, stateHome, askControl: control });
    cleanup.push(() => backend.close());
    return backend;
  };
  const state = async (backend) => displaySessionState((await backend.getState()).sessions[0]);
  return { client, session, state, sessionId: path.basename(root) };
}

it("shows NEEDS INPUT for READY rows with a review mark, and lets busy states win", () => {
  const row = { taskState: "READY", processState: "LIVE", activity: { kind: "native" }, needsReview: true };
  expect(displaySessionState(row)).toBe("NEEDS INPUT");
  expect(displaySessionState({ ...row, taskState: "WORKING" })).toBe("WORKING");
  expect(displaySessionState({ ...row, needsReview: false })).toBe("READY");
});

it("moves a session that finishes working to NEEDS INPUT, and every window sees it", async () => {
  const f = await fixture();
  const backend = f.client();
  expect(await f.state(backend)).toBe("WORKING");
  f.session.facts = READY;
  expect(await f.state(backend)).toBe("NEEDS INPUT");
  expect(await f.state(f.client())).toBe("NEEDS INPUT");
});

it("moves NEEDS INPUT to READY when the operator leaves the session, in every window", async () => {
  const f = await fixture();
  const backend = f.client();
  await backend.getState();
  f.session.facts = READY;
  await backend.getState();
  await backend.attach(f.sessionId);
  await backend.detach(f.sessionId);
  expect(await f.state(backend)).toBe("READY");
  expect(await f.state(f.client())).toBe("READY");
});

it("does not ask for review of a turn that finished while the operator was watching it", async () => {
  const f = await fixture();
  const backend = f.client();
  expect(await f.state(backend)).toBe("WORKING");
  await backend.attach(f.sessionId);
  f.session.facts = READY;
  await backend.detach(f.sessionId);
  expect(await f.state(backend)).toBe("READY");
});

it("asks for review again after the next turn finishes", async () => {
  const f = await fixture();
  const backend = f.client();
  await backend.getState();
  f.session.facts = READY;
  await backend.getState();
  await backend.detach(f.sessionId);
  f.session.facts = WORKING;
  expect(await f.state(backend)).toBe("WORKING");
  f.session.facts = READY;
  expect(await f.state(backend)).toBe("NEEDS INPUT");
});

it("does not ask for review of a session that was never seen working", async () => {
  const f = await fixture();
  f.session.facts = READY;
  expect(await f.state(f.client())).toBe("READY");
});

it("stamps when each session's shown state last changed, including leaving NEEDS INPUT for READY", async () => {
  const f = await fixture();
  const backend = f.client();
  const at = async () => Date.parse((await backend.getState()).sessions[0].stateChangedAt);
  const first = await at();
  expect(Number.isFinite(first)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await at()).toBe(first);
  f.session.facts = READY;
  const needsInput = await at();
  expect(needsInput).toBeGreaterThan(first);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await backend.detach(f.sessionId);
  expect(await at()).toBeGreaterThan(needsInput);
});
