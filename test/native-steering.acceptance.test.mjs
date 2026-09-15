import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

/**
 * What the operator's two submission keys do to a session that is already running, end to end.
 *
 * A real daemon, a real worker, and a Pi that models both delivery queues: the fake holds its tool
 * call until this test releases it, so the queued lines are provably in place while the turn is
 * still inside that tool. Operator-visible failure: Enter lands after the whole run instead of at
 * the next boundary, or Alt+Enter interrupts the run it was meant to follow.
 */

const fakePiSource = await readFile(fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url)), "utf8");
const harness = createRealProcessHarness("native-steering-acceptance");

afterEach(async () => {
  await harness.cleanup();
});

function request(clientId, requestId, op, payload) {
  return { version: 1, clientId, requestId, op, payload };
}

/** Read the fake Pi's own run trace: what it was told, and what it delivered when. */
async function trace(log) {
  return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

/** @param {string} log @param {(entries: any[]) => boolean} predicate */
async function waitForTrace(log, predicate) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const entries = await trace(log).catch(() => []);
    if (predicate(entries)) return entries;
    if (Date.now() >= deadline) throw new Error(`The fake Pi trace never reached the expected state: ${JSON.stringify(entries)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("delivers Enter at the running turn's tool boundary and Alt+Enter after the whole run settles", async () => {
  const root = await harness.stateRoot("pi-agents-native-steering-", ["canonical", "daemon", "sessions", "runs", "index"]);
  const executable = join(root, "pi");
  const log = join(root, "fake-pi.jsonl");
  const gate = join(root, "release-tool");
  await writeFile(executable, fakePiSource, { mode: 0o700 });
  await chmod(executable, 0o700);
  const env = { ...process.env, FAKE_PI_LOG: log, FAKE_PI_QUEUE: "1", FAKE_PI_TOOL_GATE: gate };
  let client;
  try {
    const started = await harness.daemon("start", { root, piBin: executable, env, timeoutMs: 20_000 });
    expect(started).toMatchObject({ code: 0, result: { kind: "daemon_started" } });
    client = createDaemonClient({ socketPath: join(root, "daemon", "control.sock"), token: (await readFile(join(root, "daemon", "control.token"), "utf8")).trim(), clientId: "native-steering", reconnect: false, maxBytes: 256 * 1024 });
    await client.connect();
    const launched = await client.request(request("native-steering", "launch", "launch", {
      prompt: "start the run",
      cwd: root,
      sourceSessionId: "dashboard-native-steering",
      isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: [] },
    }));
    if (!launched.ok) throw new Error(`Launch failed: ${JSON.stringify(launched)}`);
    const sessionId = launched.result.sessionId;
    const records = await new RegistryStore(join(root, "sessions")).list();
    if (records[0]?.ownership?.process !== undefined) await harness.record("launched worker", records[0].ownership.process);

    // The run is inside its tool call and cannot leave it until this test says so, so both keys are
    // pressed against a session that is provably mid-run.
    await waitForTrace(log, (entries) => entries.some((entry) => entry.kind === "tool_held"));
    const steered = await client.request(request("native-steering", "enter", "prompt", { sessionId, text: "check the lint first" }));
    const followed = await client.request(request("native-steering", "alt-enter", "follow_up", { sessionId, text: "summarize when done" }));
    expect([steered, followed]).toMatchObject([{ ok: true, result: { kind: "command", sessionId } }, { ok: true, result: { kind: "command", sessionId } }]);

    await writeFile(gate, "release\n", { mode: 0o600 });
    const entries = await waitForTrace(log, (values) => values.filter((entry) => entry.kind === "settled").length >= 2);

    // The whole run, in the order Pi ran it: the steered line joins the turn in progress at its tool
    // boundary, before the next model call; the follow-up waits for the agent to stop.
    expect(entries.filter((entry) => ["delivered", "model_call", "tool_held", "settled"].includes(entry.kind)).map((entry) => [entry.kind, entry.phase ?? entry.message ?? ""])).toEqual([
      ["delivered", "start"],
      ["model_call", "start the run"],
      ["tool_held", ""],
      ["delivered", "tool_boundary"],
      ["model_call", "check the lint first"],
      ["settled", ""],
      ["delivered", "after_run"],
      ["model_call", "summarize when done"],
      ["settled", ""],
    ]);
    expect(entries.filter((entry) => entry.kind === "delivered").map((entry) => [entry.source, entry.message])).toEqual([
      ["prompt", "start the run"],
      ["steer", "check the lint first"],
      ["follow_up", "summarize when done"],
    ]);
    // Each key crossed the worker as one Pi prompt naming what to do with it during a run.
    expect(entries.filter((entry) => entry.kind === "command" && entry.message !== undefined).map(({ command, message, streamingBehavior }) => [command, message, streamingBehavior])).toEqual([
      ["prompt", "start the run", "steer"],
      ["prompt", "check the lint first", "steer"],
      ["prompt", "summarize when done", "followUp"],
    ]);
  } finally {
    await client?.close();
    const stopped = await harness.daemon("stop", { root, allowLiveWorkers: true, env });
    if (![0, 3].includes(stopped.code)) throw new Error(`Daemon cleanup failed: ${JSON.stringify(stopped)}`);
  }
}, 40_000);
