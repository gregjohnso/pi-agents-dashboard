/**
 * The installed-artifact harness for the seam D acceptance suite.
 *
 * Everything here resolves out of one consumer's `node_modules`, so the cases drive the real packaged
 * `AgentSessionRuntime`, `SessionManager` and canonical coordinator rather than a checkout or a local
 * re-implementation. `PI_SEAM_D_CONSUMER` names that consumer; with none, the managed matrix skips.
 *
 * The fake host is a faithful stand-in for pi-agents' reservation obligations. It records calls. It is not
 * the durable Task 14 journal: nothing here is fsynced, locked or reconciled, and no case may be read as
 * evidence about durable storage or about the pre-spawn startup reservation Task 16 owns.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CONSUMER = process.env.PI_SEAM_D_CONSUMER;
const REPOSITORY = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
export const COHORT_ROOT = CONSUMER ?? REPOSITORY;

/**
 * Resolve an installed entry point from the consumer's own `node_modules`, by reading the package's own
 * `exports` map. `require.resolve` cannot be used: upstream declares an `import` condition and no `require`
 * condition, and `import.meta.resolve` here would anchor on this repository instead.
 */
export function resolveInstalled(consumer, specifier) {
  const [scope, name, ...rest] = specifier.split("/");
  const packageName = specifier.startsWith("@") ? `${scope}/${name}` : scope;
  const subpath = specifier.startsWith("@") ? rest : [name, ...rest];
  const roots = [
    path.join(path.resolve(consumer), "node_modules", packageName),
    path.join(path.resolve(consumer), "node_modules/@earendil-works/pi-coding-agent/node_modules", packageName),
  ];
  const root = roots.find((candidate) => existsSync(path.join(candidate, "package.json")));
  if (!root) throw new Error(`${packageName} is not installed under ${consumer}`);
  const meta = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const key = subpath.length === 0 ? "." : `./${subpath.join("/")}`;
  const entry = meta.exports?.[key];
  const target = typeof entry === "string" ? entry : (entry?.import ?? entry?.default ?? meta.main);
  if (!target) throw new Error(`installed ${packageName} declares no export for ${key}`);
  return path.join(root, target);
}

export async function importInstalled(specifier) {
  return import(pathToFileURL(resolveInstalled(COHORT_ROOT, specifier)).href);
}

/** A faithful fake of the host's canonical obligations, over the seam A host it extends. */
export function createFakeCanonicalHost(ownerRunId, overrides = {}) {
  const host = {
    ownerRunId,
    admitted: [],
    envelopes: [],
    committed: [],
    aborted: [],
    submissionRefusals: [],
    reservations: 0,
    decide: async () => ({ reservationId: `reservation-${++host.reservations}` }),
    commit: async () => {},
    async beforeNativeSubmit(envelope) {
      host.envelopes.push(envelope);
      return {
        authorized: true,
        fence: {
          submissionId: envelope.submissionId,
          ownerRunId,
          bindingGeneration: envelope.binding.generation,
          nonce: "nonce",
        },
      };
    },
    async recordEffectivePayload() {
      return { recorded: true };
    },
    nativeSubmitOutcome(outcome) {
      if (outcome.appliedAs === "refused") host.submissionRefusals.push(outcome.code);
    },
    async admitCanonicalOperation(operation) {
      host.admitted.push(operation);
      return host.decide(operation);
    },
    async commitBinding(commit) {
      host.committed.push(commit);
      return host.commit(commit);
    },
    async abortReservation(abort) {
      host.aborted.push(abort);
    },
    /** Every admitted operation kind, in order. */
    operations: () => host.admitted.map((entry) => entry.operation),
    targets: () => host.admitted.map((entry) => entry.resolvedTarget.canonicalFile),
    ...overrides,
  };
  return host;
}

/** A seam A host with no canonical trio: canonical behaviour must stay unmanaged. */
export function createSubmissionOnlyHost(ownerRunId) {
  const full = createFakeCanonicalHost(ownerRunId);
  return {
    ownerRunId,
    admitted: full.admitted,
    beforeNativeSubmit: full.beforeNativeSubmit,
    recordEffectivePayload: full.recordEffectivePayload,
    nativeSubmitOutcome: full.nativeSubmitOutcome,
  };
}

/**
 * A real `AgentSessionRuntime` over real `AgentSession`s, built from the installed cohort.
 *
 * No provider key, no network and no model: the barrier and the coordinator run before any of that, and the
 * runtime paths under test are session-file paths.
 */
export async function createInstalledRuntime({ workspace } = {}) {
  const pi = await importInstalled("@earendil-works/pi-coding-agent");
  const { Agent } = await importInstalled("@earendil-works/pi-agent-core");
  const ai = await importInstalled("@earendil-works/pi-ai/compat");
  const root = workspace ?? mkdtempSync(path.join(tmpdir(), "pi-seam-d-"));
  const sessions = path.join(root, "sessions");
  const model = ai.getModel("anthropic", "claude-sonnet-4-5");

  class Stream extends ai.EventStream {
    constructor() {
      super(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return event.message;
          if (event.type === "error") return event.error;
          throw new Error("unexpected event");
        },
      );
    }
  }
  const assistant = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "mock",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  const resourceLoader = () => ({
    getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  });

  const sessionOf = (sessionManager) => {
    const agent = new Agent({
      getApiKey: () => "test-key",
      initialState: { model, systemPrompt: "Test", tools: [] },
      streamFn: () => {
        const stream = new Stream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: assistant("") });
          stream.push({ type: "done", message: assistant("ok") });
        });
        return stream;
      },
    });
    return new pi.AgentSession({
      agent,
      sessionManager,
      settingsManager: pi.SettingsManager.create(root, root),
      cwd: root,
      modelRuntime: {
        hasConfiguredAuth: () => true,
        checkAuth: async () => ({ type: "api_key", key: "test-key" }),
        isUsingOAuth: () => false,
        getAvailableSnapshot: () => [],
        getModel: () => undefined,
        getError: () => undefined,
        getAuth: async () => undefined,
      },
      resourceLoader: resourceLoader(),
    });
  };

  const services = { cwd: root, agentDir: root };
  const created = [];
  const createRuntime = async ({ sessionManager }) => {
    const session = sessionOf(sessionManager);
    created.push(session);
    return { session, services, diagnostics: [] };
  };

  const first = pi.SessionManager.create(root, sessions);
  const session = sessionOf(first);
  created.push(session);
  const runtime = new pi.AgentSessionRuntime(session, services, createRuntime, []);
  return {
    pi,
    runtime,
    root,
    sessions,
    /** Give the owner a real canonical file on disk, the way a first assistant response does. */
    persist(sessionManager) {
      sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
      sessionManager.appendMessage(assistant("hi"));
      return sessionManager.getSessionFile();
    },
    dispose() {
      for (const entry of created) {
        try {
          entry.dispose();
        } catch {
          // A session disposed twice by a failed replacement is not a case failure.
        }
      }
    },
  };
}
