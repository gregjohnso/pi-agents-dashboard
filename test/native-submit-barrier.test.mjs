// Seam A acceptance: the native submission barrier, exercised through an installed Pi artifact.
//
// The barrier is Pi's, not this repository's, so every assertion here drives real Pi code from an
// installed package rather than a local re-implementation of a queue or a controller. Point
// `PI_SEAM_A_CONSUMER` at a directory whose `node_modules` holds the cohort to exercise:
//
//   - a consumer built from `vendor/pi/` with the seam A patch applied -> these cases pass
//   - an unpatched Pi 0.84.3 install                                   -> these cases fail on the
//     observable behaviour the patch corrects (dispatch count, retained draft, receipts)
//
// Without the variable the managed matrix is skipped, so the default suite stays green and never
// collects a known-red baseline. The one always-on case is unmanaged compatibility, which must hold on
// a patched and an unpatched install alike.
//
// Only the public seam is used here: `setNativeSubmissionHost` plus the real submission entry points. The
// barrier instance and its grants are deliberately not exported, so this suite cannot forge one either.
//
// The durable host is a faithful fake of pi-agents' obligations. It is not the ledger of Task 13 and it
// proves nothing about durability.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const CONSUMER = process.env.PI_SEAM_A_CONSUMER;
const REPOSITORY = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const COHORT_ROOT = CONSUMER ?? REPOSITORY;

/**
 * Resolve an installed entry point from the consumer's own `node_modules`, by reading the package's own
 * `exports` map. `require.resolve` cannot be used: upstream declares an `import` condition and no
 * `require` condition, and `import.meta.resolve` here would anchor on this repository instead.
 */
function resolveInstalled(consumer, specifier) {
  const [scope, name, ...rest] = specifier.split("/");
  const packageName = specifier.startsWith("@") ? `${scope}/${name}` : scope;
  const subpath = specifier.startsWith("@") ? rest : [name, ...rest];
  // An install that hoisted only coding-agent and tui keeps the rest of the cohort nested under
  // coding-agent, which is exactly how the unpatched baseline in this repository is laid out.
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

let pi;
let tui;
let workspace;

beforeAll(async () => {
  const entry = resolveInstalled(COHORT_ROOT, "@earendil-works/pi-coding-agent");
  pi = await import(pathToFileURL(entry).href);
  tui = await import(pathToFileURL(resolveInstalled(COHORT_ROOT, "@earendil-works/pi-tui")).href);
  workspace = mkdtempSync(path.join(tmpdir(), "pi-seam-a-"));
  // Named in the record so a reviewer can tell which install produced a result.
  console.log(`seam A acceptance resolved coding-agent from ${entry}`);
});

afterAll(() => {
  if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

const OWNER = "acceptance-owner-run";

/** A faithful fake of the host's authorize-then-record obligations. Records only. */
function createFakeDurableHost(overrides = {}) {
  const host = {
    ownerRunId: OWNER,
    envelopes: [],
    payloads: [],
    outcomes: [],
    blobs: [],
    decide: async (envelope) => ({
      authorized: true,
      fence: {
        submissionId: envelope.submissionId,
        ownerRunId: OWNER,
        bindingGeneration: envelope.binding.generation,
        nonce: `nonce-${envelope.submissionId}`,
      },
    }),
    record: async () => ({ recorded: true }),
    async beforeNativeSubmit(envelope) {
      host.envelopes.push(envelope);
      for (const attachment of envelope.attachments ?? []) {
        host.blobs.push({
          sha256: attachment.sha256,
          byteLength: attachment.byteLength,
          observed: createHash("sha256").update(Buffer.from(attachment.bytes)).digest("hex"),
          text: Buffer.from(attachment.bytes).toString("utf8"),
        });
      }
      return host.decide(envelope);
    },
    async recordEffectivePayload(payload) {
      host.payloads.push(payload);
      return host.record(payload);
    },
    nativeSubmitOutcome(outcome) {
      host.outcomes.push(outcome);
    },
    appliedAs: () => host.outcomes.map((outcome) => outcome.appliedAs),
    ...overrides,
  };
  return host;
}

/** The managed activation surface. Absent on an unpatched install, which is the point of the baseline. */
function activate(host) {
  expect(typeof pi.setNativeSubmissionHost).toBe("function");
  pi.setNativeSubmissionHost(host);
}

async function createSession(options = {}) {
  const { Agent } = await import(pathToFileURL(resolveInstalled(COHORT_ROOT, "@earendil-works/pi-agent-core")).href);
  const ai = await import(pathToFileURL(resolveInstalled(COHORT_ROOT, "@earendil-works/pi-ai/compat")).href);
  const model = ai.getModel("anthropic", "claude-sonnet-4-5");
  const dir = mkdtempSync(path.join(workspace, "session-"));
  const state = { prompted: 0 };

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

  const agent = new Agent({
    getApiKey: () => "test-key",
    initialState: { model, systemPrompt: "Test", tools: [] },
    streamFn: (_model, _context, streamOptions) => {
      state.prompted++;
      const stream = new Stream();
      if (options.holdStream) {
        const signal = streamOptions?.signal;
        queueMicrotask(() => {
          stream.push({ type: "start", partial: assistant("") });
          const settleStream = () => {
            if (signal?.aborted) stream.push({ type: "error", reason: "aborted", error: assistant("aborted") });
            else setTimeout(settleStream, 5);
          };
          settleStream();
        });
      } else {
        queueMicrotask(() => {
          stream.push({ type: "start", partial: assistant("") });
          stream.push({ type: "done", message: assistant("ok") });
        });
      }
      return stream;
    },
  });

  const sessionManager = pi.SessionManager.inMemory(dir);
  const settingsManager = pi.SettingsManager.create(dir, dir);
  const session = new pi.AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd: dir,
    // No real provider, no credential file and no network: the barrier runs before any of that, and the
    // successful paths need only an auth answer.
    modelRuntime: {
      hasConfiguredAuth: () => true,
      checkAuth: async () => ({ type: "api_key", key: "test-key" }),
      isUsingOAuth: () => false,
      getAvailableSnapshot: () => [],
      getModel: () => undefined,
      getError: () => undefined,
      getAuth: async () => undefined,
    },
    resourceLoader: resourceLoader(options.prompts),
  });
  return { session, state, sessionManager, dir };
}

/** The ResourceLoader surface AgentSession uses, with nothing discovered from disk. */
function resourceLoader(prompts = []) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts, diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function editorTheme() {
  const identity = (text) => text;
  return {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  };
}

// The Editor uses exactly two things from its TUI: a render request and the terminal row count.
function editorHost() {
  return { requestRender() {}, terminal: { rows: 24, columns: 80 } };
}

/**
 * The installed `InteractiveMode`'s real submit handler over a real `AgentSession` and a real `Editor`,
 * built from the prototype the way upstream's own interactive tests do. No TUI is started; every
 * collaborator the submission barrier touches is the installed one.
 */
function interactiveMode(session, editor, errors, overrides = {}) {
  const mode = Object.assign(Object.create(pi.InteractiveMode.prototype), {
    defaultEditor: editor,
    editor,
    // `session` and `sessionManager` are getters over the runtime host, so the host is what we provide.
    runtimeHost: { session },
    ui: { requestRender() {}, setFocus() {} },
    // The container and keybindings `setCustomEditorComponent` installs a component through.
    editorContainer: { clear() {}, addChild() {} },
    keybindings: { getEffectiveConfig: () => ({}) },
    disposeActiveSelector: () => {},
    compactionQueuedMessages: [],
    pendingUserInputs: [],
    pendingUserInputTickets: [],
    pendingBashComponents: [],
    isBashMode: false,
    showStatus: () => {},
    showError: (message) => errors.push(message),
    showWarning: (message) => errors.push(message),
    updatePendingMessagesDisplay: () => {},
    flushPendingBashComponents: () => {},
    updateEditorBorderColor: () => {},
    ...overrides,
  });
  pi.InteractiveMode.prototype.setupEditorSubmitHandler.call(mode);
  return mode;
}

describe("seam A: the required runtime", () => {
  it("runs on Node >=22.19.0 <23, the runtime the plan pins", () => {
    // Persisted, not just logged: Vitest buffers a passing test's console output, so the interpreter
    // identity is written where it survives as evidence. TMPDIR is the driver's own case directory.
    const receipt = {
      version: process.version,
      execPath: process.execPath,
      arch: process.arch,
      consumer: CONSUMER ?? null,
      recordedAt: new Date().toISOString(),
    };
    const target = path.join(process.env.TMPDIR ?? tmpdir(), "seam-a-acceptance-runtime.json");
    writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`acceptance runtime ${process.version} execPath=${process.execPath} receipt=${target}`);
    const [major, minor] = process.versions.node.split(".").map(Number);
    expect(`${major}`, `unexpected Node ${process.version} at ${process.execPath}`).toBe("22");
    expect(minor).toBeGreaterThanOrEqual(19);
  });
});

describe("seam A: unmanaged Pi is unchanged", () => {
  it("prompts the agent with no host registered and asks nothing of any host", async () => {
    if (pi.setNativeSubmissionHost) pi.setNativeSubmissionHost(undefined);
    const { session, state } = await createSession();
    try {
      await session.prompt("hello");
      expect(state.prompted).toBe(1);
    } finally {
      session.dispose();
    }
  });
});

describe.skipIf(!CONSUMER)("seam A: the managed submission barrier, through the installed artifact", () => {
  afterEach(() => {
    if (pi.setNativeSubmissionHost) pi.setNativeSubmissionHost(undefined);
  });

  it("A-1 authorizes before the agent is prompted and reports one applied receipt", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session, state } = await createSession();
    try {
      await session.prompt("first", { nativeSubmit: { source: "startup-prompt" } });
      expect(host.envelopes.map((envelope) => envelope.source)).toEqual(["startup-prompt"]);
      expect(host.envelopes[0].originalText).toBe("first");
      expect(host.envelopes[0].ownerRunId).toBe(OWNER);
      expect(state.prompted).toBe(1);
      expect(host.appliedAs()).toEqual(["applied"]);
    } finally {
      session.dispose();
    }
  });

  it("A-2 dispatches nothing on refusal, a thrown handler, a missing fence or a mismatched generation", async () => {
    const cases = [
      ["refusal", async () => ({ authorized: false, code: "PERSISTENCE_FAILED", reason: "fsync failed" })],
      ["thrown", async () => {
        throw new Error("ledger unavailable");
      }],
      ["no fence", async () => ({ authorized: true })],
      ["stale generation", async (envelope) => ({
        authorized: true,
        fence: {
          submissionId: envelope.submissionId,
          ownerRunId: OWNER,
          bindingGeneration: envelope.binding.generation + 7,
          nonce: "n",
        },
      })],
      ["foreign owner", async (envelope) => ({
        authorized: true,
        fence: {
          submissionId: envelope.submissionId,
          ownerRunId: "someone-else",
          bindingGeneration: envelope.binding.generation,
          nonce: "n",
        },
      })],
    ];
    for (const [label, decide] of cases) {
      const host = createFakeDurableHost({ decide });
      activate(host);
      const { session, state } = await createSession();
      try {
        await expect(session.prompt("blocked"), label).rejects.toThrow(/native submission refused/);
        expect(state.prompted, label).toBe(0);
      } finally {
        session.dispose();
      }
    }
  });

  it("A-3 distinguishes failed from uncertain persistence and refuses both", async () => {
    for (const code of ["PERSISTENCE_FAILED", "PERSISTENCE_UNCERTAIN"]) {
      const host = createFakeDurableHost({ decide: async () => ({ authorized: false, code, reason: code }) });
      activate(host);
      const { session, state } = await createSession();
      try {
        await expect(session.prompt("either")).rejects.toThrow(new RegExp(code));
        expect(state.prompted).toBe(0);
      } finally {
        session.dispose();
      }
    }
  });

  it("A-4 refuses a duplicate submission the host reports as already dispatched", async () => {
    const host = createFakeDurableHost({
      decide: async () => ({ authorized: false, code: "DUPLICATE_SUBMISSION", reason: "already at DISPATCH_STARTED" }),
    });
    activate(host);
    const { session, state } = await createSession();
    try {
      await expect(session.prompt("again")).rejects.toThrow(/DUPLICATE_SUBMISSION/);
      expect(state.prompted).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it("A-5 refuses a forged handoff: forwarding state is barrier-owned and cannot be minted", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session, state } = await createSession();
    try {
      for (const forged of ["handoff:not-mine", "", 42, {}]) {
        await expect(
          session.prompt("forged", { nativeSubmit: { handoff: forged } }),
          String(forged),
        ).rejects.toThrow(/native submission refused|requires the barrier-issued handoff/);
      }
      expect(state.prompted).toBe(0);
      // A refused forgery never reached the host at all.
      expect(host.envelopes).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it("A-6 refuses a drain that presents no barrier-issued handoff", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session, state } = await createSession();
    try {
      await expect(session.prompt("drain", { nativeSubmit: { drain: true } })).rejects.toThrow(
        /requires the barrier-issued handoff/,
      );
      expect(state.prompted).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it("A-7 labels a steer and a follow-up by their own entry points and queues each once", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session } = await createSession();
    try {
      await session.steer("steered");
      await session.followUp("followed");
      expect(host.envelopes.map((envelope) => [envelope.source, envelope.intent])).toEqual([
        ["native-steer", "steer"],
        ["native-followup", "follow_up"],
      ]);
      expect(session.pendingMessageCount).toBe(2);
      expect(host.appliedAs()).toEqual(["queued", "queued"]);
    } finally {
      session.dispose();
    }
  });

  it("A-8 queues nothing when a steer or a follow-up is refused", async () => {
    const host = createFakeDurableHost({
      decide: async () => ({ authorized: false, code: "REFUSED", reason: "not now" }),
    });
    activate(host);
    const { session } = await createSession();
    try {
      await expect(session.steer("blocked")).rejects.toThrow(/REFUSED/);
      await expect(session.followUp("blocked")).rejects.toThrow(/REFUSED/);
      expect(session.pendingMessageCount).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it("A-9 labels a template-only expansion template on both direct queue APIs, never skill", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const prompts = [
      {
        name: "tmpl",
        description: "a template",
        content: "expanded template body",
        sourceInfo: pi.createSyntheticSourceInfo("/tmp/tmpl.md", { source: "test" }),
        filePath: "/tmp/tmpl.md",
      },
    ];
    const { session } = await createSession({ prompts });
    try {
      await session.steer("/tmpl");
      expect(host.payloads.at(-1)).toEqual({
        submissionId: host.envelopes[0].submissionId,
        effectiveText: "expanded template body",
        expandedFrom: "template",
      });
      await session.followUp("/tmpl");
      expect(host.payloads.at(-1)?.expandedFrom).toBe("template");
      expect(host.payloads.every((payload) => payload.expandedFrom !== "skill")).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it("A-10 records no receipt for a submission nothing expanded", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session } = await createSession();
    try {
      await session.steer("nothing to expand");
      expect(host.payloads).toEqual([]);
      expect(host.appliedAs()).toEqual(["queued"]);
    } finally {
      session.dispose();
    }
  });

  it("A-11 authorizes a streaming submission with the streaming behavior recorded", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session } = await createSession({ holdStream: true });
    try {
      const running = session.prompt("first");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(session.isStreaming).toBe(true);
      await session.prompt("second", { streamingBehavior: "steer" });
      expect(host.envelopes.map((envelope) => envelope.behavior)).toEqual(["idle", "streaming"]);
      expect(host.envelopes[1].intent).toBe("steer");
      expect(session.pendingMessageCount).toBe(1);
      await session.abort();
      await running.catch(() => {});
    } finally {
      session.dispose();
    }
  });

  it("A-12 hands the host the actual attachment bytes, not only a descriptor", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session } = await createSession();
    try {
      const payload = Buffer.from("attachment-bytes");
      await session.prompt("look at this", {
        images: [{ type: "image", data: payload.toString("base64"), mimeType: "image/png" }],
      });
      expect(host.blobs).toHaveLength(1);
      expect(host.blobs[0].text).toBe("attachment-bytes");
      expect(host.blobs[0].byteLength).toBe(payload.byteLength);
      expect(host.blobs[0].observed).toBe(host.blobs[0].sha256);
      const [descriptor] = host.envelopes[0].attachments;
      expect(descriptor.kind).toBe("image");
      expect(descriptor.mediaType).toBe("image/png");
    } finally {
      session.dispose();
    }
  });

  it("A-13 loses no attachment on a refusal: the bytes were offered before any mutation", async () => {
    const host = createFakeDurableHost({
      decide: async () => ({ authorized: false, code: "PERSISTENCE_FAILED", reason: "blob store full" }),
    });
    activate(host);
    const { session, state } = await createSession();
    try {
      const payload = Buffer.from("kept-bytes");
      await expect(
        session.prompt("with image", {
          images: [{ type: "image", data: payload.toString("base64"), mimeType: "image/png" }],
        }),
      ).rejects.toThrow(/PERSISTENCE_FAILED/);
      expect(state.prompted).toBe(0);
      expect(host.blobs[0].text).toBe("kept-bytes");
    } finally {
      session.dispose();
    }
  });

  it("A-14 a temporary SessionManager for another session does not stale a pending grant", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session, state } = await createSession();
    try {
      host.decide = async (envelope) => {
        // Exactly what the selector's rename path does: a temporary manager over a different session.
        const other = pi.SessionManager.inMemory();
        other.newSession();
        return {
          authorized: true,
          fence: {
            submissionId: envelope.submissionId,
            ownerRunId: OWNER,
            bindingGeneration: envelope.binding.generation,
            nonce: "n",
          },
        };
      };
      await session.prompt("unaffected");
      expect(state.prompted).toBe(1);
      expect(host.appliedAs()).toEqual(["applied"]);
    } finally {
      session.dispose();
    }
  });

  it("A-15 a real rebind of the owner's own session between grant and mutation refuses without mutating", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session, state, sessionManager, dir } = await createSession();
    try {
      host.decide = async (envelope) => {
        sessionManager.setSessionFile(path.join(dir, "rebound.jsonl"));
        return {
          authorized: true,
          fence: {
            submissionId: envelope.submissionId,
            ownerRunId: OWNER,
            bindingGeneration: envelope.binding.generation,
            nonce: "n",
          },
        };
      };
      await expect(session.prompt("stale")).rejects.toThrow(/STALE_BINDING/);
      expect(state.prompted).toBe(0);
      expect(host.outcomes).toEqual([
        {
          submissionId: host.envelopes[0].submissionId,
          appliedAs: "refused",
          code: "STALE_BINDING",
          beforeMutation: true,
        },
      ]);
    } finally {
      session.dispose();
    }
  });

  it("A-16 retains the draft on refusal and on a bare grant, clearing only on the revision-bound commit", async () => {
    const editor = new tui.Editor(editorHost(), editorTheme());
    editor.setText("operator draft");
    editor.submitGate = () => false;
    editor.handleInput("\r");
    expect(editor.getText()).toBe("operator draft");

    let submitted;
    let grantedRevision;
    editor.onSubmit = (text) => {
      submitted = text;
    };
    editor.submitGate = (submission) => {
      grantedRevision = submission.draftRevision;
      return true;
    };
    editor.handleInput("\r");
    // Authorization is permission to attempt, not to destroy: the native mutation can still be refused.
    expect(submitted).toBe("operator draft");
    expect(editor.getText()).toBe("operator draft");

    // A stale revision never overwrites the current draft; the submitted revision clears it.
    expect(editor.commitSubmittedDraft(grantedRevision - 1)).toBe(false);
    expect(editor.getText()).toBe("operator draft");
    expect(editor.commitSubmittedDraft(grantedRevision)).toBe(true);
    expect(editor.getText()).toBe("");
  });

  it("A-16b keeps a paste body and cursor across a refused submission, so nothing is reconstructed", async () => {
    const editor = new tui.Editor(editorHost(), editorTheme());
    editor.setText("before ");
    editor.handleInput(`\x1b[200~${"pasted line\n".repeat(12)}\x1b[201~`);
    const text = editor.getText();
    const expanded = editor.getExpandedText();
    const cursor = editor.getCursor();
    expect(text).toMatch(/\[paste #1 \+\d+ lines\]/);

    // The gate grants, but the host never commits: this is the stale-fence shape.
    editor.submitGate = () => true;
    editor.onSubmit = () => {};
    editor.handleInput("\r");
    expect(editor.getText()).toBe(text);
    expect(editor.getExpandedText()).toBe(expanded);
    expect(editor.getCursor()).toEqual(cursor);
  });

  it("A-17 offers the gate the untouched draft, not the trimmed text", async () => {
    const editor = new tui.Editor(editorHost(), editorTheme());
    editor.setText("  padded draft  ");
    const seen = [];
    editor.submitGate = (submission) => {
      seen.push(submission);
      return false;
    };
    editor.handleInput("\r");
    expect(seen).toHaveLength(1);
    // The envelope's originalText comes from this field, before trim or paste expansion.
    expect(seen[0].originalText).toBe("  padded draft  ");
    expect(seen[0].text).toBe("padded draft");
    expect(editor.getText()).toBe("  padded draft  ");
  });

  it("A-18 never restores an authorized draft over an intervening edit", async () => {
    const editor = new tui.Editor(editorHost(), editorTheme());
    editor.setText("authorized");
    let release;
    editor.submitGate = () => new Promise((resolve) => (release = resolve));
    let submitted;
    editor.onSubmit = (text) => {
      submitted = text;
    };
    editor.handleInput("\r");
    expect(editor.getText()).toBe("authorized");
    editor.setText("typed while deciding");
    release(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submitted).toBe("authorized");
    expect(editor.getText()).toBe("typed while deciding");
    // A commit for the older revision is refused, so the newer draft survives.
    expect(editor.commitSubmittedDraft(0)).toBe(false);
    expect(editor.getText()).toBe("typed while deciding");
  });

  it("A-20 binds an idle Alt+Enter commit to the revision it submitted, never to an edit made while deciding", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session } = await createSession();
    try {
      const editor = new tui.Editor(editorHost(), editorTheme());
      const errors = [];
      const mode = interactiveMode(session, editor, errors);

      editor.setText("follow-up draft");
      // Authorization is still pending when the operator keeps typing.
      let release;
      host.decide = (envelope) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              authorized: true,
              fence: {
                submissionId: envelope.submissionId,
                ownerRunId: OWNER,
                bindingGeneration: envelope.binding.generation,
                nonce: "n",
              },
            });
        });
      const followUp = pi.InteractiveMode.prototype.handleFollowUp.call(mode);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(editor.getText()).toBe("follow-up draft");
      editor.setText("typed while deciding");
      release();
      await followUp;
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The gesture authorized and queued the text it submitted...
      expect(host.envelopes.map((envelope) => [envelope.source, envelope.originalText])).toEqual([
        ["native-followup", "follow-up draft"],
      ]);
      expect(mode.pendingUserInputs).toEqual(["follow-up draft"]);
      // ...and its commit is bound to the revision it submitted, so the newer draft survives untouched.
      expect(editor.getText()).toBe("typed while deciding");
      expect(errors).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it("A-21 refuses a replayed handoff after the first post-queue continuation, and prompts the agent once", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session, state } = await createSession();
    try {
      const editor = new tui.Editor(editorHost(), editorTheme());
      const errors = [];
      const mode = interactiveMode(session, editor, errors);

      editor.setText("one prompt only");
      editor.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The idle push consumed the fence and queued the input: terminal acceptance for this submission.
      expect(mode.pendingUserInputs).toEqual(["one prompt only"]);
      expect(host.appliedAs()).toEqual(["queued"]);

      const input = await mode.getUserInput();
      const forwarded = pi.InteractiveMode.prototype.takeNativeSubmitForCurrentInput.call(mode);
      // The first post-queue continuation needs no fresh authorization and no second fence consumption,
      // and it must still reach the agent.
      await session.prompt(input, forwarded);
      expect(state.prompted).toBe(1);
      expect(host.envelopes).toHaveLength(1);

      // `PromptOptions.nativeSubmit` is public, so a caller can present the same token again. It must not
      // dispatch a second time.
      await expect(session.prompt(input, forwarded)).rejects.toThrow(/DUPLICATE_SUBMISSION/);
      expect(state.prompted).toBe(1);
      expect(host.envelopes).toHaveLength(1);
      expect(
        host.outcomes.filter((outcome) => outcome.appliedAs === "refused" && outcome.beforeMutation === true),
      ).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });

  it("A-22 reports an afterDispatch draft commit that throws, and keeps the submission accepted", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session, state } = await createSession();
    try {
      const editor = new tui.Editor(editorHost(), editorTheme());
      const errors = [];
      // A command classification, so the grant is queued with its fence unconsumed and the retained draft's
      // commit travels to the later boundary. No extension is installed in this consumer, so the boundary
      // that consumes the fence is the prompt's own dispatch; the commit registration is the same one.
      const mode = interactiveMode(session, editor, errors, { isExtensionCommand: () => true });
      editor.setText("/seamcmd");
      editor.commitSubmittedDraft = () => {
        throw new Error("the editor could not clear the committed draft");
      };
      editor.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const input = await mode.getUserInput();
      const forwarded = pi.InteractiveMode.prototype.takeNativeSubmitForCurrentInput.call(mode);
      await session.prompt(input, forwarded);

      // The mutation committed, so the submission stays accepted...
      expect(state.prompted).toBe(1);
      expect(host.appliedAs()).toEqual(["applied"]);
      // ...and the commit failure reached the owning error channel instead of being discarded.
      expect(errors.join("\n")).toMatch(/could not be cleared: the editor could not clear the committed draft/);
    } finally {
      session.dispose();
    }
  });
});

/**
 * A real legacy editor component: the extension-provided shape that predates the barrier. It implements
 * `EditorComponent`'s required surface and none of its optional hooks, destroys its own state before it tells
 * the application anything, and can deliver that call asynchronously.
 */
class LegacyEditorComponent {
  text = "";
  /** Component-private state Pi neither reads nor reconstructs. */
  privateState = [];
  /** Every public call Pi made on this component, so recovery can be shown to be text-only. */
  calls = [];
  deliver = (submit) => submit();
  getText() {
    this.calls.push("getText");
    return this.text;
  }
  setText(text) {
    this.calls.push(`setText(${JSON.stringify(text)})`);
    this.text = text;
  }
  handleInput(data) {
    if (data !== "\r") {
      this.text += data;
      this.privateState.push(`typed:${data}`);
      return;
    }
    const submitted = this.text;
    // The legacy order: clear the component's own screen first, then tell the application.
    this.text = "";
    this.privateState.push("self-cleared");
    this.deliver(() => this.onSubmit?.(submitted));
  }
  render() {
    return [this.text];
  }
}

/**
 * A custom editor that adopts the optional hooks: it asks the gate, retains the whole draft until the
 * revision-bound commit, and therefore keeps full preservation.
 */
class CooperatingEditorComponent {
  text = "";
  draftRevision = 0;
  committed = [];
  getText() {
    return this.text;
  }
  setText(text) {
    this.text = text;
    this.draftRevision++;
  }
  commitSubmittedDraft(revision) {
    this.committed.push(revision);
    if (revision !== this.draftRevision) return false;
    this.text = "";
    this.draftRevision++;
    return true;
  }
  async handleInput(data) {
    if (data !== "\r") {
      this.text += data;
      this.draftRevision++;
      return;
    }
    const submitted = this.text;
    const granted =
      (await this.submitGate?.({
        text: submitted.trim(),
        originalText: submitted,
        draftRevision: this.draftRevision,
      })) ?? true;
    if (!granted) return;
    this.onSubmit?.(submitted);
  }
  render() {
    return [this.text];
  }
}

/**
 * Compatibility-first draft preservation (INTERFACE.md §8.6b), through the installed artifact: a real legacy
 * editor component stays usable in a managed session, the session states the reduced preservation once, and
 * the recovery it does get is submitted-text-only.
 */
describe.skipIf(!CONSUMER)("seam A: a legacy editor component in a managed session", () => {
  afterEach(() => {
    if (pi.setNativeSubmissionHost) pi.setNativeSubmissionHost(undefined);
  });

  /** A managed mode whose installed editor component is `component`, through the real install path. */
  function managedModeWith(session, component) {
    const errors = [];
    const warnings = [];
    const mode = interactiveMode(session, new tui.Editor(editorHost(), editorTheme()), errors, {
      showWarning: (message) => warnings.push(message),
    });
    pi.InteractiveMode.prototype.setCustomEditorComponent.call(mode, () => component);
    return { mode, errors, warnings };
  }

  it("A-23 states the reduced draft preservation once, and still authorizes and queues the submission", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session } = await createSession();
    try {
      const legacy = new LegacyEditorComponent();
      const { mode, errors, warnings } = managedModeWith(session, legacy);

      legacy.handleInput("first prompt");
      legacy.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The limitation is named, with the hooks that would lift it, on the session's own warning channel.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/Draft preservation is unavailable in this managed session/);
      expect(warnings[0]).toMatch(/submitGate/);
      expect(warnings[0]).toMatch(/commitSubmittedDraft/);
      // Compatibility-first: the component is not wrapped, disabled or refused, and dispatch stays fenced.
      expect(host.envelopes.map((envelope) => [envelope.source, envelope.originalText])).toEqual([
        ["native-editor", "first prompt"],
      ]);
      expect(host.appliedAs()).toEqual(["queued"]);
      expect(mode.pendingUserInputs).toEqual(["first prompt"]);
      expect(errors).toEqual([]);

      // Said once per installed component, not once per submission.
      legacy.handleInput("second prompt");
      legacy.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(warnings).toHaveLength(1);
      expect(mode.pendingUserInputs).toEqual(["first prompt", "second prompt"]);
    } finally {
      session.dispose();
    }
  });

  it("A-24 recovers a refused legacy submission as submitted text only, reconstructing nothing", async () => {
    const host = createFakeDurableHost({
      decide: async () => ({ authorized: false, code: "PERSISTENCE_FAILED", reason: "ledger unavailable" }),
    });
    activate(host);
    const { session, state } = await createSession();
    try {
      const legacy = new LegacyEditorComponent();
      const { mode, errors } = managedModeWith(session, legacy);

      legacy.handleInput("refused draft");
      const privateStateBefore = [...legacy.privateState];
      legacy.calls.length = 0;
      legacy.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Fail-closed: the component cleared its own screen, but nothing was queued or prompted.
      expect(mode.pendingUserInputs).toEqual([]);
      expect(state.prompted).toBe(0);
      expect(host.appliedAs()).toEqual([]);
      expect(errors.join("\n")).toMatch(/ledger unavailable/);
      // The weaker contract: the submitted text goes back, and that is all Pi touches.
      expect(legacy.text).toBe("refused draft");
      expect(legacy.calls).toEqual(["getText", 'setText("refused draft")']);
      // The component's own private state is its business: its self-clear is not undone.
      expect(legacy.privateState).toEqual([...privateStateBefore, "self-cleared"]);
    } finally {
      session.dispose();
    }
  });

  it("A-25 never restores a refused legacy submission over newer typing", async () => {
    let refuse;
    const host = createFakeDurableHost({
      decide: () =>
        new Promise((resolve) => {
          refuse = () => resolve({ authorized: false, code: "REFUSED", reason: "host said no" });
        }),
    });
    activate(host);
    const { session } = await createSession();
    try {
      const legacy = new LegacyEditorComponent();
      const { mode, errors } = managedModeWith(session, legacy);

      legacy.handleInput("older draft");
      legacy.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The component already cleared itself, and the operator starts a new draft while the host decides.
      expect(legacy.text).toBe("");
      legacy.handleInput("newer typing");
      refuse();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(legacy.text).toBe("newer typing");
      expect(mode.pendingUserInputs).toEqual([]);
      expect(errors.join("\n")).toMatch(/host said no/);
    } finally {
      session.dispose();
    }
  });

  it("A-26 authorizes a legacy editor's asynchronous submit callback and fences its queue push", async () => {
    const host = createFakeDurableHost();
    activate(host);
    const { session } = await createSession();
    try {
      const legacy = new LegacyEditorComponent();
      // Not Enter-shaped at all: the component submits later, from its own timer.
      legacy.deliver = (submit) => setTimeout(submit, 5);
      const { mode, warnings } = managedModeWith(session, legacy);

      legacy.handleInput("async submission");
      legacy.handleInput("\r");
      expect(host.envelopes).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(host.envelopes.map((envelope) => envelope.originalText)).toEqual(["async submission"]);
      expect(host.appliedAs()).toEqual(["queued"]);
      expect(mode.pendingUserInputs).toEqual(["async submission"]);
      expect(warnings).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });

  it("A-27 claims no reduced preservation for a custom editor that implements the hooks", async () => {
    let granted = false;
    const host = createFakeDurableHost();
    host.decide = async (envelope) => {
      if (!granted) return { authorized: false, code: "PERSISTENCE_FAILED", reason: "first attempt refused" };
      return {
        authorized: true,
        fence: {
          submissionId: envelope.submissionId,
          ownerRunId: OWNER,
          bindingGeneration: envelope.binding.generation,
          nonce: `nonce-${envelope.submissionId}`,
        },
      };
    };
    activate(host);
    const { session } = await createSession();
    try {
      const cooperating = new CooperatingEditorComponent();
      const { mode, warnings } = managedModeWith(session, cooperating);

      cooperating.text = "cooperating draft";
      cooperating.draftRevision = 7;
      await cooperating.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Nothing is said, because nothing is reduced: the gate retained the whole draft on the refusal.
      expect(warnings).toEqual([]);
      expect(cooperating.text).toBe("cooperating draft");
      expect(cooperating.committed).toEqual([]);
      expect(mode.pendingUserInputs).toEqual([]);

      granted = true;
      await cooperating.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(warnings).toEqual([]);
      expect(mode.pendingUserInputs).toEqual(["cooperating draft"]);
      // Cleared only through the revision-bound commit, after the queue mutation committed.
      expect(cooperating.committed).toEqual([7]);
      expect(cooperating.text).toBe("");
    } finally {
      session.dispose();
    }
  });
});

/**
 * One managed submission driven through the **rebuilt bundled CLI**, so a patch that only reached the
 * unbundled `dist` cannot pass. The extension is the supported managed activation route for a process Pi
 * launched itself: `pi.setNativeSubmissionHost` on the extension API.
 */
describe.skipIf(!CONSUMER)("seam A: through the rebuilt bundled CLI", () => {
  it("A-19 refuses a startup prompt inside the bundle and records the envelope it refused", () => {
    const cli = path.join(
      path.resolve(CONSUMER),
      "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    );
    expect(existsSync(cli)).toBe(true);

    const root = mkdtempSync(path.join(workspace, "bundle-cli-"));
    const record = path.join(root, "envelope.json");
    const extension = path.join(root, "seam-a-host.mjs");
    // A managed host that refuses everything and writes what it was asked to authorize.
    writeFileSync(
      extension,
      `import { writeFileSync } from "node:fs";
export default (pi) => {
  pi.setNativeSubmissionHost({
    ownerRunId: "bundled-cli-owner",
    async beforeNativeSubmit(envelope) {
      writeFileSync(${JSON.stringify(record)}, JSON.stringify({
        source: envelope.source,
        intent: envelope.intent,
        originalText: envelope.originalText,
        ownerRunId: envelope.ownerRunId,
        binding: envelope.binding,
      }));
      return { authorized: false, code: "PERSISTENCE_FAILED", reason: "bundled-cli probe refuses" };
    },
    async recordEffectivePayload() { return { recorded: true }; },
    nativeSubmitOutcome() {},
  });
};
`,
    );

    const result = spawnSync(
      process.execPath,
      [cli, "-e", extension, "-p", "prompt that must not dispatch", "--no-tools"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          TMPDIR: root,
          PI_OFFLINE: "1",
          NO_COLOR: "1",
          CI: "1",
        },
      },
    );
    const detail = `status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`;

    // The barrier ran inside the bundle, before any dispatch, and saw the operator's text.
    expect(existsSync(record), detail).toBe(true);
    const envelope = JSON.parse(readFileSync(record, "utf8"));
    expect(envelope.source).toBe("startup-prompt");
    expect(envelope.originalText).toBe("prompt that must not dispatch");
    expect(envelope.ownerRunId).toBe("bundled-cli-owner");
    expect(typeof envelope.binding.generation).toBe("number");

    // The refusal is fail-closed: the CLI reports it and exits nonzero rather than prompting a model.
    expect(result.status, detail).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/native submission refused|PERSISTENCE_FAILED/);
  });
});
