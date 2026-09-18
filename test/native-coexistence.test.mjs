/**
 * Coexistence acceptance: seams A, B/C/F and E active in one real bundled-CLI process.
 *
 * Each seam has its own acceptance suite; this case states the one thing none of them can, which is that the
 * three are live in the **same** process built from the **same** ordered patch series, and that activating
 * one does not disable another. It drives the real installed bundled CLI under a real pseudo-terminal and
 * reaches each seam only through a supported public caller:
 *
 *   - seam B/C/F: `test/fixtures/native-ingress/bundled-cli-host-preload.mjs`, loaded with `node --import`,
 *     registers a `NativeAttachmentHost` from the *installed* pi-tui — a second module instance from the one
 *     the bundle inlined — and authorizes the CLI's own device-attributes response.
 *   - seam E: the core bootstrap sideband named by `PI_NATIVE_BOOTSTRAP_SOCKET` delivers the readiness
 *     phases to a host listener.
 *   - seam A: `test/fixtures/native-coexistence/coexistence-extension.ts`, loaded as a real Pi extension,
 *     calls `pi.setNativeSubmissionHost` and then submits one message, which its host refuses.
 *
 * No private field is read, no adapter wraps a Pi object, and no credential is passed, so the refused
 * submission reaches no model. `PI_NATIVE_COHORT` selects the install; with nothing selected the case skips
 * rather than pretending the cohort is present.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { startBootstrapHost, spawnPiUnderPty } from "./fixtures/native-presentation/bootstrap-host.mjs";
import { resolveInstalledPackageDirectory } from "./fixtures/native-presentation/recording-terminal.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const COHORT = process.env.PI_NATIVE_COHORT;
const REPOSITORY = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const INGRESS_PRELOAD = path.join(REPOSITORY, "test/fixtures/native-ingress/bundled-cli-host-preload.mjs");
const COEXISTENCE_EXTENSION = path.join(REPOSITORY, "test/fixtures/native-coexistence/coexistence-extension.ts");
const DEVICE_ATTRIBUTES_REPLY = "\x1b[?62;c";

const harness = createRealProcessHarness("native-coexistence");

afterEach(() => harness.cleanup());

const cohortIt = (name, body) =>
  it(
    name,
    async (context) => {
      if (!COHORT) context.skip();
      await body();
    },
    240_000,
  );

function childEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (/API_KEY|_TOKEN$|CREDENTIAL|SECRET|PASSWORD/i.test(key)) delete environment[key];
    else if (/^(AWS|ANTHROPIC|OPENAI|GOOGLE|AZURE|GEMINI|XAI)_/.test(key)) delete environment[key];
  }
  return environment;
}

/** Every JSONL line one of the two test callers has written so far. */
async function events(file) {
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Resolve when `predicate` holds over the log's events, or fail naming the bound.
 *
 * The two callers append from another process, so this side gets no event for an append; the wait is a
 * bounded re-read of the file rather than an unbounded one, and a timeout is a failure, never a pass.
 */
async function waitForEvents(file, predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  while (Date.now() < deadline) {
    seen = await events(file);
    if (predicate(seen)) return seen;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} never happened within ${timeoutMs}ms; events so far: ${JSON.stringify(seen)}`);
}

describe("the composed cohort: seams A, B/C/F and E in one bundled-CLI process", () => {
  cohortIt("activates all three seams in the same process, and each one keeps its own contract", async () => {
    const root = await harness.stateRoot("native-coexistence-");
    const agentDirectory = path.join(root, "agent");
    const extensions = path.join(agentDirectory, "extensions");
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    for (const directory of [extensions, project, home]) await mkdir(directory, { recursive: true });

    // The committed extension fixture, copied into this disposable session's own extensions directory.
    await writeFile(path.join(extensions, "50-coexistence.ts"), await readFile(COEXISTENCE_EXTENSION, "utf8"));

    const ingressLog = path.join(root, "native-attachment-host.jsonl");
    const submissionLog = path.join(root, "native-submission-host.jsonl");
    await writeFile(ingressLog, "");
    await writeFile(submissionLog, "");

    const codingAgent = resolveInstalledPackageDirectory(COHORT, "@earendil-works/pi-coding-agent");
    const tuiPackageRoot = resolveInstalledPackageDirectory(COHORT, "@earendil-works/pi-tui");
    const cli = path.join(codingAgent, "dist/bundle/cli.js");
    expect(existsSync(cli), `the selected cohort has no bundled CLI at ${cli}`).toBe(true);

    const bootstrap = await startBootstrapHost();
    const pty = spawnPiUnderPty({
      command: `${process.execPath} --import ${INGRESS_PRELOAD} ${cli} --tui-mode regular`,
      cwd: project,
      env: childEnvironment({
        HOME: home,
        PI_CODING_AGENT_DIR: agentDirectory,
        PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
        PI_NATIVE_BOOTSTRAP_SOCKET: bootstrap.socketPath,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        TERM: "xterm-256color",
        COLUMNS: "100",
        LINES: "30",
        // seam B/C/F caller
        PI_NATIVE_HOST_LOG: ingressLog,
        PI_NATIVE_HOST_TUI_PACKAGE: tuiPackageRoot,
        PI_NATIVE_HOST_DECISION: "apply",
        // seam A caller
        PI_COEXISTENCE_LOG: submissionLog,
        PI_COEXISTENCE_TUI_PACKAGE: tuiPackageRoot,
      }),
      transcriptPath: path.join(root, "transcript"),
    });
    const identity = await inspectProcessIdentity(pty.child.pid);
    await harness.record("the composed bundled CLI under a pseudo-terminal", identity);

    let exited;
    try {
      // Seam E: the core bootstrap hello, then the mounted phase, on the sideband.
      const hello = await bootstrap.waitFor((frame) => frame.type === "native-bootstrap", "the bootstrap hello");
      expect(hello.capability.seam).toBe("E");
      expect(hello.pid).toBeGreaterThan(0);
      const mounted = await bootstrap.waitForPhase("native-mounted");
      expect(mounted.phase).toBe("native-mounted");

      // Seam B/C/F: the CLI queried its terminal, the installed-instance host was consulted for the reply,
      // and the reply it authorized is what the terminal applied.
      pty.write(DEVICE_ATTRIBUTES_REPLY);
      const ingressEvents = await waitForEvents(
        ingressLog,
        (seen) => seen.some((event) => event.event === "beforeApplyTerminalResponse"),
        "the installed-instance attachment host was consulted",
      );
      const registration = ingressEvents.find((event) => event.event === "registered");
      expect(registration.hostVisibleFromInstalledInstance).toBe(true);
      const authorization = ingressEvents.find((event) => event.event === "beforeApplyTerminalResponse");
      expect(authorization.kind).toBe("da");
      expect(authorization.raw).toBe(DEVICE_ATTRIBUTES_REPLY);

      // Seam A: the extension's host authorized nothing, and the refusal dispatched nothing.
      const submissionEvents = await waitForEvents(
        submissionLog,
        (seen) => seen.some((event) => event.event === "beforeNativeSubmit"),
        "the extension's submission host was consulted",
      );
      const envelope = submissionEvents.find((event) => event.event === "beforeNativeSubmit");
      expect(envelope.ownerRunId).toBe("coexistence-owner-run");
      expect(envelope.originalText).toContain("coexistence probe");
      expect(envelope.hasCanonicalFile).toBe(true);
      expect(typeof envelope.bindingGeneration).toBe("number");
      expect(submissionEvents.some((event) => event.event === "recordEffectivePayload")).toBe(false);
      const outcomes = submissionEvents.filter((event) => event.event === "nativeSubmitOutcome");
      expect(outcomes.every((outcome) => outcome.appliedAs !== "applied" && outcome.appliedAs !== "queued")).toBe(true);

      // The three seams are one process: every caller reports the CLI's own pid.
      const readiness = submissionEvents.find((event) => event.event === "readinessSnapshot");
      const attachmentVisible = submissionEvents.find((event) => event.event === "attachmentHostVisible");
      expect(readiness.phases).toContain("native-mounted");
      expect(attachmentVisible.registered).toBe(true);
      const pids = new Set([
        hello.pid,
        // Only the ingress caller's `preload` record carries a pid; its later records do not.
        ingressEvents.find((event) => event.event === "preload").pid,
        ...submissionEvents.map((event) => event.pid),
      ]);
      expect([...pids], "the seams did not all report the same process").toHaveLength(1);

      pty.write("\x04");
      exited = await exitWithin(pty, "the composed bundled CLI", 60_000);
      expect(exited.signal, `the CLI was signalled: ${JSON.stringify(exited)}`).toBe(null);
    } finally {
      await bootstrap.close();
      const accounting = path.join(os.tmpdir(), "native-coexistence-terminal.json");
      await writeFile(
        accounting,
        `${JSON.stringify(
          {
            exited: exited ?? null,
            terminalBytes: pty.length(),
            terminalOutput: pty.output(),
            attachmentHostEvents: await events(ingressLog),
            submissionHostEvents: await events(submissionLog),
          },
          null,
          2,
        )}\n`,
      );
      console.log(`native coexistence terminal accounting: ${accounting}, ${pty.length()} bytes`);
      if (!exited) {
        try {
          pty.child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

/** The child's exit, or a rejection naming the bound. A timeout is a failure here, never a pass. */
async function exitWithin(pty, label, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      pty.exited(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} had not exited within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
