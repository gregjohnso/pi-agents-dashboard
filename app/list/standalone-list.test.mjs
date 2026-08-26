import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createDaemonViewerClient, createFrontendPersistence } from "./standalone-list.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-dashboard-frontend-state-"));
  roots.push(root);
  return join(root, "frontend-state.json");
}

it("adapts the installed daemon client to origin replay, mutation, ACK, and detach", async () => {
  const requests = [];
  const events = { async *[Symbol.asyncIterator]() { yield { eventId: "one" }; } };
  const client = {
    async request(value) {
      requests.push(value);
      const result = value.op === "attach" ? { kind: "attached", role: "composer" }
        : value.op === "detach" ? { kind: "detached" }
          : { kind: "command", status: { stage: "COMPLETED" } };
      return { ok: true, result };
    },
    async getViewerSnapshot(sessionId) { return { sessionId }; },
    subscribeViewer(sessionId, cursor) { expect([sessionId, cursor.sequence]).toEqual(["session", "0"]); return events; },
    async ackViewer(cursor) { return cursor; },
  };
  const viewer = createDaemonViewerClient({ client, clientId: "client" });
  expect(viewer.replayFromOrigin).toBe(true);
  await viewer.attach("session");
  const received = [];
  const unsubscribe = viewer.subscribe("session", { sequence: "0" }, async (event) => { received.push(event); }, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  await viewer.command("interrupt", { sessionId: "session" });
  await viewer.ack("session", { sequence: "1" });
  await viewer.detach("session");
  unsubscribe();
  expect(received).toEqual([{ eventId: "one" }]);
  expect(requests.map(({ op }) => op)).toEqual(["attach", "interrupt", "detach"]);
});

it("fsyncs the private cursor file and parent directory around atomic publication", async () => {
  const path = await fixture();
  const stages = [];
  const persistence = createFrontendPersistence(path, "client", { failpoint: async (stage) => stages.push(stage) });
  await persistence.save({ schemaVersion: 1, clientId: "client", cursor: { daemonEpoch: "epoch", sequence: "1" }, viewState: { query: { view: "live" } }, launchDraft: {} });
  expect(stages).toEqual(["after_file_sync", "after_rename", "after_directory_sync"]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("does not replace the prior cursor when publication fails before rename", async () => {
  const path = await fixture();
  const original = { schemaVersion: 1, clientId: "client", cursor: { daemonEpoch: "epoch", sequence: "1" }, viewState: { query: { view: "live" } }, launchDraft: {} };
  await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const persistence = createFrontendPersistence(path, "client", { failpoint(stage) { if (stage === "after_file_sync") throw new Error("crash"); } });
  await expect(persistence.save({ ...original, cursor: { daemonEpoch: "epoch", sequence: "2" } })).rejects.toThrow("crash");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
});

it("refuses malformed or non-private cursor state", async () => {
  const path = await fixture();
  await writeFile(path, JSON.stringify({ schemaVersion: 1, clientId: "client", cursor: { daemonEpoch: "epoch", sequence: "01" } }), { mode: 0o644 });
  await expect(createFrontendPersistence(path, "client").load()).rejects.toMatchObject({ code: "FRONTEND_STATE_UNSAFE" });
});
