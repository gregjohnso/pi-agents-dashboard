/**
 * Live status and model selection in the existing manager.
 *
 * Both are judged on facts the producer actually supplied. The status mapping is fed the shape the manager's
 * own `status` answer carries (`bridge.facts`, `exit`, `reaped`), which the owner extension publishes over the
 * reviewed sideband on Pi's own lifecycle events. The catalogue is read with `pi --list-models`, which is Pi's
 * documented mechanism, so Pi resolves its own configuration and this code never reads the operator's.
 *
 * Nothing here calls a provider, reads operator configuration or starts a Pi. The end-to-end path through the
 * real dashboard lives in `manager-flow.mjs --status-and-models`.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNativeBackend, describeOwnerActivity, rowStateFromStatus } from "../../app/list/native-backend.mjs";
import { parseModelCatalogue } from "../../app/list/native-model-catalogue.mjs";

/** The table `pi --list-models` prints, with two distinct model identities. */
const CATALOGUE_TABLE = [
  "provider       model      context  max-out  thinking  images",
  "fixture-alpha  alpha-one  1K       100      no        no    ",
  "fixture-alpha  alpha-two  2K       200      yes       no    ",
  "fixture-beta   beta-one   4K       400      no        yes   ",
].join("\n");

/** One owner status as the manager reports it, with only the parts the mapping reads. */
function statusWith({ facts = undefined, exit = null, reaped = null } = {}) {
  return { owner: { pid: 4242 }, attachments: [], exit, reaped, bridge: facts === undefined ? { connected: false, facts: {} } : { connected: true, facts } };
}

describe("the catalogue comes from Pi's own listing", () => {
  it("parses provider, model and thinking, keeping two distinct identities apart", () => {
    const models = parseModelCatalogue(CATALOGUE_TABLE);
    expect(models).toEqual([
      { provider: "fixture-alpha", id: "alpha-one", thinking: false },
      { provider: "fixture-alpha", id: "alpha-two", thinking: true },
      { provider: "fixture-beta", id: "beta-one", thinking: false },
    ]);
  });

  it("reads Pi's honest empty answer as empty rather than inventing a model", () => {
    const empty = "No models available. Use /login to log into a provider via OAuth or API key. See:\n  docs/providers.md";
    expect(parseModelCatalogue(empty)).toEqual([]);
  });

  it("carries no field Pi did not print, so nothing private can reach a picker row", () => {
    for (const model of parseModelCatalogue(CATALOGUE_TABLE)) {
      expect(Object.keys(model).sort()).toEqual(["id", "provider", "thinking"]);
    }
  });

  it("surfaces a catalogue failure instead of answering with an empty list", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-models-"));
    const client = createNativeBackend({
      sessionsHome,
      listModels: async () => { throw Object.assign(new Error("pi --list-models exited 1: boom"), { code: "MODEL_CATALOG_FAILED" }); },
    });
    await expect(client.getModels()).rejects.toThrow(/list-models/u);
    client.close();
  });

  it("asks Pi once and reuses the answer, so opening the picker is not a fork bomb", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-models-"));
    let calls = 0;
    const client = createNativeBackend({
      sessionsHome,
      listModels: async () => { calls += 1; return CATALOGUE_TABLE; },
    });
    expect(await client.getModels()).toHaveLength(3);
    expect(await client.getModels()).toHaveLength(3);
    expect(calls).toBe(1);
    client.close();
  });
});

describe("a selected model reaches the launch", () => {
  /** A backend whose `runDemo` records argv instead of starting a Pi. */
  function recording(sessionsHome) {
    const calls = [];
    const client = createNativeBackend({
      sessionsHome,
      runDemo: async (args) => {
        calls.push(args);
        const rootIndex = args.indexOf("--root");
        if (rootIndex !== -1) await mkdir(args[rootIndex + 1], { recursive: true });
        return { code: 0, output: "" };
      },
      listModels: async () => CATALOGUE_TABLE,
    });
    return { client, calls };
  }

  const SHARED = (cwd) => ({ mode: "shared_directory", confirmedCwd: cwd, ownerSessionIds: [] });

  it("passes the composer's chosen provider and model through to the owner launch", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-models-"));
    const { client, calls } = recording(sessionsHome);
    await client.launch({
      prompt: "do the thing", cwd: sessionsHome, sourceSessionId: "dashboard-test",
      isolation: SHARED(sessionsHome), model: { provider: "fixture-beta", id: "beta-one" },
    });
    const args = calls[0];
    expect(args.join(" ")).toContain("--provider fixture-beta");
    expect(args.join(" ")).toContain("--model beta-one");
    client.close();
  });

  it("distinguishes a second selection, so the picker is not decorative", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-models-"));
    const { client, calls } = recording(sessionsHome);
    for (const id of ["alpha-one", "alpha-two"]) {
      await client.launch({
        prompt: `task for ${id}`, cwd: sessionsHome, sourceSessionId: "dashboard-test",
        isolation: SHARED(sessionsHome), model: { provider: "fixture-alpha", id },
      });
    }
    expect(calls[0].join(" ")).toContain("--model alpha-one");
    expect(calls[1].join(" ")).toContain("--model alpha-two");
    client.close();
  });

  it("names no provider when the composer chose none, leaving Pi its own selection", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-models-"));
    const { client, calls } = recording(sessionsHome);
    await client.launch({ prompt: "x", cwd: sessionsHome, sourceSessionId: "dashboard-test", isolation: SHARED(sessionsHome) });
    expect(calls[0]).not.toContain("--provider");
    expect(calls[0]).not.toContain("--model");
    client.close();
  });

  it("keeps the requested model distinct from the one Pi confirmed", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-models-"));
    const { client } = recording(sessionsHome);
    const requested = { provider: "fixture-alpha", id: "alpha-one" };
    // Pi answered with a different model, which is Pi's right: /model is Pi's own behaviour.
    const row = rowStateFromStatus(statusWith({ facts: { modelProvider: "fixture-alpha", modelId: "alpha-two", idle: true } }), { requestedModel: requested });
    expect(row.model).toEqual({ provider: "fixture-alpha", id: "alpha-two" });
    expect(row.requestedModel).toEqual(requested);
    expect(row.modelIsObserved).toBe(true);
    client.close();
  });

  it("marks the model as requested-only until Pi confirms one", () => {
    const requested = { provider: "fixture-beta", id: "beta-one" };
    const row = rowStateFromStatus(statusWith({ facts: { idle: true } }), { requestedModel: requested });
    expect(row.requestedModel).toEqual(requested);
    expect(row.modelIsObserved).toBe(false);
  });
});

describe("row state comes from published facts, never from a guess", () => {
  it("says the state is not reported when the owner published nothing", () => {
    const row = rowStateFromStatus(statusWith({}), {});
    expect(row.stateIsKnown).toBe(false);
    expect(describeOwnerActivity(row)).toMatch(/not reported/u);
  });

  it("reports WORKING while Pi's agent loop is running", () => {
    const row = rowStateFromStatus(statusWith({ facts: { agentPhase: "start", idle: false, pendingMessages: false } }), {});
    expect(row.taskState).toBe("WORKING");
    expect(row.stateIsKnown).toBe(true);
  });

  it("reports WAITING when Pi says work is queued", () => {
    const row = rowStateFromStatus(statusWith({ facts: { agentPhase: "settled", pendingMessages: true } }), {});
    expect(row.taskState).toBe("WAITING");
  });

  it("reports READY only once Pi says the run settled", () => {
    const row = rowStateFromStatus(statusWith({ facts: { agentPhase: "settled", idle: true, pendingMessages: false } }), {});
    expect(row.taskState).toBe("READY");
    expect(row.stateIsKnown).toBe(true);
  });

  it("keeps the agent loop ending distinct from the run settling", () => {
    const ended = rowStateFromStatus(statusWith({ facts: { agentPhase: "end", idle: true } }), {});
    expect(describeOwnerActivity(ended)).toMatch(/ended/u);
    expect(describeOwnerActivity(ended)).not.toMatch(/settled/u);
  });

  it("does not read model-loop idle as nothing running", () => {
    const row = rowStateFromStatus(statusWith({ facts: { agentPhase: "settled", idle: true, pendingMessages: false } }), {});
    // Pi reports its own model loop. It says nothing about background work, and neither may this row.
    expect(describeOwnerActivity(row)).toMatch(/model loop/u);
    expect(describeOwnerActivity(row)).toMatch(/background work not reported/u);
    expect(row.backgroundWorkKnown).toBe(false);
  });

  it("invents no background or completion counts", () => {
    const row = rowStateFromStatus(statusWith({ facts: { agentPhase: "settled", idle: true } }), {});
    expect(describeOwnerActivity(row)).not.toMatch(/\d+ (task|job|turn|background)/u);
    expect(row.backgroundCount).toBeUndefined();
  });

  it("reports FAILED from an explicit non-zero exit, not from a guess", () => {
    const row = rowStateFromStatus(statusWith({ facts: { agentPhase: "settled" }, exit: { status: 1, code: 1, signal: null } }), {});
    expect(row.taskState).toBe("FAILED");
    expect(row.processState).toBe("EXITED");
    expect(describeOwnerActivity(row)).toMatch(/exited 1|code 1/u);
  });

  it("reports a clean exit as stopped rather than failed", () => {
    const row = rowStateFromStatus(statusWith({ facts: {}, exit: { status: 0, code: 0, signal: null } }), {});
    expect(row.taskState).toBe("STOPPED");
    expect(row.processState).toBe("EXITED");
  });

  it("reports a signalled owner as failed and names the signal", () => {
    const row = rowStateFromStatus(statusWith({ facts: {}, exit: { status: null, code: null, signal: "SIGKILL" } }), {});
    expect(row.taskState).toBe("FAILED");
    expect(describeOwnerActivity(row)).toMatch(/SIGKILL/u);
  });

  /**
   * Corrected: this case used to require `EXITED`, which claimed a death nobody observed. A failed connection
   * is not evidence of exit, so the row now uses the repository's existing unconfirmed-worker representation.
   */
  it("reports an unreachable owner as unconfirmed, never as exited or ready", () => {
    const row = rowStateFromStatus(undefined, {});
    expect(row.processState).toBe("STALE");
    expect(row.taskState).not.toBe("STOPPED");
    expect(row.taskState).not.toBe("FAILED");
    expect(row.stateIsKnown).toBe(false);
    expect(describeOwnerActivity(row)).toMatch(/could not be reached/u);
    expect(describeOwnerActivity(row)).toMatch(/may still be running/u);
  });

  it("leaks no unexpected fact into the row or its summary", () => {
    const row = rowStateFromStatus(statusWith({
      facts: { agentPhase: "settled", idle: true, apiKey: "sk-secret-value", sessionFile: "/home/op/.pi/x.jsonl", cwd: "/home/op/private" },
    }), {});
    const rendered = `${JSON.stringify(row)} ${describeOwnerActivity(row)}`;
    expect(rendered).not.toMatch(/sk-secret-value/u);
    expect(rendered).not.toMatch(/\.pi\//u);
    expect(rendered).not.toMatch(/home\/op\/private/u);
  });
});

describe("reading status does not cause the next read", () => {
  it("raises no list invalidation while statuses are read repeatedly", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-status-"));
    const root = path.join(sessionsHome, "session-live");
    await mkdir(root, { recursive: true });
    const client = createNativeBackend({ sessionsHome, listModels: async () => CATALOGUE_TABLE });
    let changes = 0;
    const unsubscribe = await client.subscribeListChanges(() => { changes += 1; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const baseline = changes;
    // What a live owner does while the list reads it, plus the reads themselves.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await writeFile(path.join(root, "manager.log"), `line ${attempt}\n`, { flag: "a" });
      await client.getState();
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(changes).toBe(baseline);
    unsubscribe();
    client.close();
  });
});

describe("Pi's own listing is what the catalogue reads", () => {
  it("prints a two-model fixture catalogue through the real CLI, with no operator configuration", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "native-pi-home-"));
    const fixture = path.join(home, "fixture-provider.ts");
    await writeFile(fixture, [
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      "export default function (pi: ExtensionAPI) {",
      '  pi.registerProvider("fixture-alpha", {',
      '    name: "Fixture Alpha", baseUrl: "http://127.0.0.1:0/unused", apiKey: "fixture-no-credential",',
      '    api: "openai-completions",',
      "    models: [",
      '      { id: "alpha-one", name: "Alpha One", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 },',
      '      { id: "alpha-two", name: "Alpha Two", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2000, maxTokens: 200 },',
      "    ],",
      "  });",
      "}",
    ].join("\n"));
    const { resolveCohort } = await import("./cohort.mjs");
    const cohort = resolveCohort({});
    const printed = execFileSync(process.execPath, [cohort.bundledCli, "--list-models", "--no-extensions", "-e", fixture], {
      // A disposable HOME and config directory: Pi resolves its own configuration and finds only the fixture.
      env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "dumb", PI_CODING_AGENT_DIR: path.join(home, ".pi") },
      encoding: "utf8", timeout: 120_000,
    });
    const models = parseModelCatalogue(printed);
    expect(models).toEqual([
      { provider: "fixture-alpha", id: "alpha-one", thinking: false },
      { provider: "fixture-alpha", id: "alpha-two", thinking: true },
    ]);
  }, 180_000);
});

describe("the manager's Stop action reaches the native owner", () => {
  /**
   * The operator's crash: `dashboard.mjs` dispatches `this.client[action](sessionId, revision, requestId)` with
   * `action` of `"stop"`, and the native backend had no such method, so Stop died as
   * `STOP_FAILED ... is not a function` instead of stopping anything.
   */
  it("exposes the methods the controller dispatches, so Stop is not an undefined function", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-stop-"));
    const client = createNativeBackend({ sessionsHome, listModels: async () => CATALOGUE_TABLE });
    for (const action of ["stop", "delete"]) {
      expect(typeof client[action], `client.${action}`).toBe("function");
    }
    client.close();
  });

  it("reports the owner's own wait status, so a receipt is not mistaken for an exit", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-stop-"));
    const client = createNativeBackend({
      sessionsHome, listModels: async () => CATALOGUE_TABLE,
      // The manager's real answer shape: a `stopped` frame carrying the owner's wait status.
      askControl: async () => ({ reachable: true, answer: { type: "stopped", exit: { status: 0, code: 0, signal: null } } }),
    });
    const outcome = await client.stop("session-1", 1, "request-1");
    expect(outcome.exit).toEqual({ status: 0, code: 0, signal: null });
    expect(outcome.observedExit).toBe(true);
    client.close();
  });

  it("does not claim a stop when the manager answered without a wait status", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-stop-"));
    const client = createNativeBackend({
      sessionsHome, listModels: async () => CATALOGUE_TABLE,
      askControl: async () => ({ reachable: true, answer: { type: "stopped" } }),
    });
    const outcome = await client.stop("session-1", 1, "request-1");
    expect(outcome.observedExit).toBe(false);
    client.close();
  });

  it("treats a connection failure as a failure, never as stopped", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-stop-"));
    const client = createNativeBackend({
      sessionsHome, listModels: async () => CATALOGUE_TABLE,
      askControl: async () => ({ reachable: false, reason: "closed before answering" }),
    });
    await expect(client.stop("session-1", 1, "request-1")).rejects.toThrow(/closed before answering/u);
    client.close();
  });

  it("keeps the controller's revision semantics instead of stopping the wrong record", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-stop-"));
    let asked = 0;
    const client = createNativeBackend({
      sessionsHome, listModels: async () => CATALOGUE_TABLE,
      askControl: async () => { asked += 1; return { reachable: true, answer: { type: "stopped", exit: { status: 0, code: 0, signal: null } } }; },
    });
    await expect(client.stop("session-1", 99, "request-1")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    // Nothing was asked of the owner on a stale revision.
    expect(asked).toBe(0);
    client.close();
  });

  it("names delete as unsupported rather than crashing or pretending it worked", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-stop-"));
    const client = createNativeBackend({ sessionsHome, listModels: async () => CATALOGUE_TABLE });
    await expect(client.delete("session-1", 1, "request-1")).rejects.toMatchObject({ code: "ACTION_UNSUPPORTED" });
    await expect(client.delete("session-1", 1, "request-1")).rejects.toThrow(/delete/u);
    client.close();
  });

  it("shows the observed exit on the row after a stop, rather than only 'unreachable'", () => {
    const row = rowStateFromStatus(undefined, { observedExit: { status: 0, code: 0, signal: null } });
    expect(row.processState).toBe("EXITED");
    expect(row.taskState).toBe("STOPPED");
    expect(row.stateIsKnown).toBe(true);
    expect(describeOwnerActivity(row)).toMatch(/exited 0/u);
  });

  it("shows a non-zero observed exit as failed", () => {
    const row = rowStateFromStatus(undefined, { observedExit: { status: 3, code: 3, signal: null } });
    expect(row.taskState).toBe("FAILED");
    expect(describeOwnerActivity(row)).toMatch(/exited 3/u);
  });
});
