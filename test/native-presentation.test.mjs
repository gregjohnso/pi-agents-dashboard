/**
 * Seam E acceptance: cold presentation and readiness, exercised against an installed Pi artifact.
 *
 * `PI_SEAM_E_CONSUMER` selects which install is exercised. Point it at a directory holding a
 * `node_modules` with the produced tarballs to run the seam cases against a patched build, or at an
 * unpatched Pi 0.84.3 install to observe the baseline red. With no consumer selected the suite resolves the
 * repository's own read-only install, and the cases that need the seam skip, so the default suite stays
 * green without pretending the seam is present.
 *
 * These cases drive the real exported `TuiAltScreen`, the real `Editor`, real overlays and a real
 * `ScrollView` through a recording terminal. Where a case reads Kitty protocol bytes it says so: protocol
 * bytes are not proof of visual output on a real Kitty terminal, and no visual-parity claim is made here.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "../runtime/process-signaler.mjs";
import { startBootstrapHost, spawnPiUnderPty } from "./fixtures/native-presentation/bootstrap-host.mjs";
import {
  editorTheme,
  nextFrames,
  RecordingTerminal,
  resolveInstalledEntry,
  resolveInstalledPackageDirectory,
} from "./fixtures/native-presentation/recording-terminal.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

// The install under test: a consumer directory holding the produced tarballs, or the repository's own
// read-only install when nothing is selected.
const installRoot = process.env.PI_SEAM_E_CONSUMER ? path.resolve(process.env.PI_SEAM_E_CONSUMER) : process.cwd();

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const KITTY_TRANSMIT = "\x1b_Ga=T";
const KITTY_PLACE = "\x1b_Ga=p";

let tui;
let codingAgent;
let seamPresent = false;
let resolutionError;

beforeAll(async () => {
  try {
    tui = await import(resolveInstalledEntry(installRoot, "@earendil-works/pi-tui"));
    codingAgent = await import(resolveInstalledEntry(installRoot, "@earendil-works/pi-coding-agent"));
  } catch (error) {
    resolutionError = error;
    return;
  }
  seamPresent =
    typeof tui.isNativePresentationTui === "function" &&
    typeof codingAgent.presentTerminal === "function" &&
    typeof codingAgent.onNativeReadiness === "function" &&
    typeof codingAgent.nativeReadinessSnapshot === "function";
});

/** A case that needs the seam. Skipped, never silently passed, when the install does not carry it. */
const seamIt = (name, body) =>
  it(name, async (context) => {
    if (!seamPresent) context.skip();
    await body();
  });

/**
 * A case that runs against whichever install was explicitly selected, patched or not.
 *
 * These express the cold-presentation requirement through the strongest trigger the install offers, so an
 * unpatched selection produces real behavioural red. They skip when no install is selected, so the
 * repository's committed default suite stays green without pretending the seam is present.
 */
const consumerIt = (name, body) =>
  it(name, async (context) => {
    if (!process.env.PI_SEAM_E_CONSUMER) context.skip();
    await body();
  });

function startAltScreen({ columns = 60, rows = 8, children = [], layoutRoot } = {}) {
  const terminal = new RecordingTerminal(columns, rows);
  const renderer = new tui.TuiAltScreen(terminal);
  for (const child of children) renderer.addChild(child);
  if (layoutRoot) renderer.setLayoutRoot(layoutRoot);
  renderer.start();
  return { terminal, renderer };
}

function text(value) {
  return new tui.Text(value, 0, 0);
}

/**
 * The strongest cold refresh the install offers.
 *
 * On a patched install that is `presentNow`. On an unpatched 0.84.3 it is the public forced render, which
 * is the only trigger a host has: `renderNow(true)` calls `resetRenderState()` and redraws the whole
 * screen. The two cases that use this run against whichever install is selected, so the unpatched run is
 * real behavioural red reaching real stock code rather than a missing-symbol setup failure.
 */
function coldRefresh(renderer, requestId) {
  if (typeof renderer.presentNow === "function") {
    return renderer.presentNow({ requestId, coldTerminal: true });
  }
  renderer.renderNow(true);
  return { presented: true, receipt: undefined };
}

/**
 * A layout holding Pi's own `Image` component.
 *
 * The public API has no `registerKittyImageMetadata`, and an unregistered pre-encoded line is never entered
 * into the transmission cache, so the real component is what makes the cache assertions meaningful.
 */
function imageLayout() {
  const image = new tui.Image(
    "A".repeat(8192),
    "image/png",
    { fallbackColor: (value) => value },
    {},
    { widthPx: 100, heightPx: 100 },
  );
  return new tui.VStack([
    { component: text("header"), basis: "auto" },
    {
      component: new tui.HStack([
        { component: text("left"), basis: 10 },
        { component: image, basis: 10 },
      ]),
      basis: 4,
    },
  ]);
}

describe("seam E: the installed artifact", () => {
  it("runs on the Node runtime the repository declares", () => {
    // Runtime qualification, recorded here so a green suite cannot hide an out-of-range runtime.
    const [major, minor] = process.versions.node.split(".").map(Number);
    expect(`${process.execPath} ${process.version}`).toContain("v");
    expect(major, `Node ${process.version} at ${process.execPath} is outside >=22.19.0 <23`).toBe(22);
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(22 * 1000 + 19);
  });

  it("resolves the selected install and reports whether it carries the seam", () => {
    expect(resolutionError, `resolving Pi from ${installRoot} failed`).toBeUndefined();
    expect(typeof tui.TuiAltScreen).toBe("function");
    // Recorded, not asserted: an unpatched install legitimately has no seam and the seam cases skip.
    expect(typeof seamPresent).toBe("boolean");
  });

  it("keeps unmanaged rendering working with no host, on a patched or unpatched install", async () => {
    const { terminal, renderer } = startAltScreen({ children: [text("unmanaged line")] });
    await nextFrames();
    expect(terminal.all()).toContain(ENTER_ALT_SCREEN);
    expect(terminal.all()).toContain("unmanaged line");
    renderer.stop();
    expect(terminal.stopped).toBe(true);
  });

  consumerIt("brings a cold terminal's modes current after a warm frame", async () => {
    const { terminal, renderer } = startAltScreen({ children: [text("current ui")] });
    terminal.negotiatedKittyFlags = 7;
    await nextFrames();

    const before = terminal.writes.length;
    coldRefresh(renderer, "attach-cold:1:1");
    const bytes = terminal.since(before);
    // A cold client missed every one of these at startup. A forced redraw alone replays none of them.
    expect(bytes).toContain(ENTER_ALT_SCREEN);
    expect(bytes).toContain(DISABLE_AUTOWRAP);
    expect(bytes).toContain("\x1b[?2004h");
    renderer.stop();
  });

  consumerIt("retransmits a cached image for a cold terminal instead of placing one it never received", async () => {
    tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    try {
      const { terminal, renderer } = startAltScreen({ rows: 6, layoutRoot: imageLayout() });
      await nextFrames();
      expect(terminal.all()).toContain(KITTY_TRANSMIT);

      const before = terminal.writes.length;
      coldRefresh(renderer, "attach-cold:1:2");
      const bytes = terminal.since(before);
      // Stock `resetRenderState()` clears the text screen but keeps `uploadedKittyImages`, so the cold
      // terminal is told to place an image it was never sent.
      expect(bytes).toContain(KITTY_TRANSMIT);
      renderer.stop();
    } finally {
      tui.resetCapabilitiesCache();
    }
  });

  seamIt("declares seam E only", async () => {
    const capability = codingAgent.nativePresentationCapability();
    expect(capability.seam).toBe("E");
    const notDelivered = capability.notDelivered.join(" ");
    for (const absent of ["seam A", "seam B", "seam C", "seam D", "seam F", "seam G", "gate 5"]) {
      expect(notDelivered).toContain(absent);
    }
  });

  seamIt("writes nothing to an idle attached terminal until a presentation is requested", async () => {
    const { terminal, renderer } = startAltScreen({ children: [text("current ui")] });
    await nextFrames();
    const quiet = terminal.writes.length;
    await nextFrames();
    expect(terminal.writes.length).toBe(quiet);

    const outcome = renderer.presentNow({ requestId: "attach-1:1:1", coldTerminal: true });
    expect(outcome.presented).toBe(true);
    expect(terminal.writes.length).toBeGreaterThan(quiet);
    renderer.stop();
  });

  seamIt("reasserts the modes a cold terminal missed and issues no query", async () => {
    const { terminal, renderer } = startAltScreen({ children: [text("current ui")] });
    terminal.negotiatedKittyFlags = 7;
    await nextFrames();

    const before = terminal.writes.length;
    const outcome = renderer.presentNow({ requestId: "attach-1:1:1", coldTerminal: true });
    const bytes = terminal.since(before);
    expect(outcome.presented).toBe(true);
    expect(bytes).toContain(ENTER_ALT_SCREEN);
    expect(bytes).toContain(DISABLE_AUTOWRAP);
    expect(bytes).toContain("\x1b[?2004h");
    expect(terminal.reassertCalls).toBe(1);
    expect(bytes).not.toContain("\x1b[c");
    expect(bytes).not.toContain("\x1b[?u");
    expect(bytes).not.toContain("\x1b[16t");
    expect(bytes).not.toContain("\x1b[>7u");
    expect(bytes).toContain("\x1b[=7;1u");
    expect(outcome.receipt.cold.terminalModes.kittyKeyboard).toEqual({
      flags: 7,
      reemitted: true,
      mechanism: "set-flags",
    });
    expect(outcome.receipt.cold.rendererModes).toContain("alt-screen");

    const warmBefore = terminal.writes.length;
    const warm = renderer.presentNow({ requestId: "attach-1:1:2", coldTerminal: false });
    expect(warm.presented).toBe(true);
    expect(warm.receipt.cold).toBeUndefined();
    expect(terminal.since(warmBefore)).not.toContain(ENTER_ALT_SCREEN);
    expect(terminal.reassertCalls).toBe(1);
    renderer.stop();
  });

  seamIt("retransmits Kitty image payloads for a cold terminal (protocol bytes, not visual output)", async () => {
    tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    try {
      const { terminal, renderer } = startAltScreen({ rows: 6, layoutRoot: imageLayout() });
      await nextFrames();
      expect(terminal.all()).toContain(KITTY_TRANSMIT);

      const warmBefore = terminal.writes.length;
      const warm = renderer.presentNow({ requestId: "warm", coldTerminal: false });
      const warmBytes = terminal.since(warmBefore);
      expect(warm.presented).toBe(true);
      expect(warmBytes).not.toContain(KITTY_TRANSMIT);
      expect(warmBytes).toContain(KITTY_PLACE);

      const coldBefore = terminal.writes.length;
      const cold = renderer.presentNow({ requestId: "cold", coldTerminal: true });
      const coldBytes = terminal.since(coldBefore);
      expect(cold.presented).toBe(true);
      expect(coldBytes).toContain(KITTY_TRANSMIT);
      expect(cold.receipt.cold.imageProtocol).toBe("kitty");
      expect(cold.receipt.cold.invalidatedImageIds.length).toBeGreaterThan(0);
      renderer.stop();
    } finally {
      tui.resetCapabilitiesCache();
    }
  });

  seamIt("leaves the shared draft, focus, an overlay and the scroll position alone", async () => {
    const terminal = new RecordingTerminal(60, 8);
    const renderer = new tui.TuiAltScreen(terminal);
    const editor = new tui.Editor(renderer, editorTheme, {});
    const transcript = new tui.ScrollView(
      text(Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n")),
      { follow: "end", primary: true },
    );
    renderer.setLayoutRoot(
      new tui.VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: editor, basis: "auto", grow: 0, shrink: 1, minSize: 3 },
      ]),
    );
    renderer.start();
    await nextFrames();

    editor.setText("operator draft");
    renderer.setFocus(editor);
    // Non-capturing so focus stays on the editor: a presentation must change neither.
    const overlay = renderer.showOverlay(
      { render: () => ["overlay body"], invalidate: () => {} },
      { anchor: "center", nonCapturing: true },
    );
    renderer.scrollToTop();
    await nextFrames();
    const focusBefore = renderer.getFocusedComponent();
    const scrollTop = renderer.viewportTop;

    const outcome = renderer.presentNow({ requestId: "cold", coldTerminal: true });
    expect(outcome.presented).toBe(true);
    expect(editor.getText()).toBe("operator draft");
    expect(renderer.getFocusedComponent()).toBe(focusBefore);
    expect(focusBefore).toBe(editor);
    expect(renderer.hasOverlay()).toBe(true);
    expect(renderer.viewportTop).toBe(scrollTop);
    // The frame is the current native UI, rendered by Pi's own components, not a replayed buffer.
    expect(terminal.all()).toContain("overlay body");
    expect(terminal.all()).toContain("operator draft");

    overlay.hide();
    renderer.stop();
  });

  seamIt("mints a nonce only for a frame that reached the terminal, with the geometry it was built at", async () => {
    // Multibyte text, so a UTF-16 code-unit count and a UTF-8 byte count cannot be mistaken for each other.
    const { terminal, renderer } = startAltScreen({ columns: 44, rows: 7, children: [text("héllo — ünïcode")] });
    await nextFrames();

    const received = [];
    const unsubscribe = renderer.onFrameHandedToTerminal((receipt) => received.push(receipt));
    renderer.requestRender();
    expect(received).toHaveLength(0);

    const before = terminal.writes.length;
    const outcome = renderer.presentNow({ requestId: "attach-9:2:31", coldTerminal: true });
    expect(outcome.presented).toBe(true);
    expect(received).toHaveLength(1);
    expect(outcome.receipt.requestId).toBe("attach-9:2:31");
    expect(outcome.receipt.columns).toBe(44);
    expect(outcome.receipt.rows).toBe(7);
    const frameWrite = terminal.writes.slice(before).find((data) => data.includes("\x1b[?2026h"));
    expect(outcome.receipt.byteLength).toBe(Buffer.byteLength(frameWrite));
    expect(Buffer.byteLength(frameWrite)).toBeGreaterThan(frameWrite.length);
    expect(outcome.receipt.sequence).toBeGreaterThan(0);
    expect(renderer.lastFrameReceipt().frameId).toBe(outcome.receipt.frameId);

    unsubscribe();
    renderer.stop();
  });

  seamIt("hands one copy of the frame over even when the sink reports backpressure", async () => {
    const { terminal, renderer } = startAltScreen({ children: [text("current ui")] });
    await nextFrames();
    const before = terminal.writes.length;
    const outcome = renderer.presentNow({ requestId: "cold", coldTerminal: true });
    expect(outcome.presented).toBe(true);
    const frames = terminal.writes.slice(before).filter((data) => data.includes("\x1b[?2026h"));
    expect(frames).toHaveLength(1);
    renderer.stop();
  });

  seamIt("presents nothing after the renderer released the terminal", async () => {
    const { terminal, renderer } = startAltScreen({ children: [text("current ui")] });
    await nextFrames();
    renderer.stop();
    const before = terminal.writes.length;
    const outcome = renderer.presentNow({ requestId: "cold", coldTerminal: true });
    expect(outcome).toEqual({ presented: false, reason: "renderer-stopped" });
    expect(terminal.since(before)).toBe("");
  });

  seamIt("presents one complete frame from the main-screen renderer and mints its receipt", async () => {
    const terminal = new RecordingTerminal(60, 8);
    const renderer = new tui.TuiMainScreen(terminal);
    renderer.addChild(text("current ui"));
    renderer.start();
    await nextFrames();

    expect(tui.isNativePresentationTui(renderer)).toBe(true);
    const before = terminal.writes.length;
    const outcome = renderer.presentNow({ requestId: "main:1:1", coldTerminal: true });
    expect(outcome.presented).toBe(true);
    expect(outcome.receipt.requestId).toBe("main:1:1");
    expect(outcome.receipt.columns).toBe(60);
    expect(outcome.receipt.rows).toBe(8);
    expect(terminal.reassertCalls).toBe(1);
    const frames = terminal.writes.slice(before).filter((data) => data.includes("\x1b[?2026h"));
    expect(frames).toHaveLength(1);
    expect(outcome.receipt.byteLength).toBe(Buffer.byteLength(frames[0]));
    expect(frames[0]).toContain("current ui");
    // This renderer owns no modes of its own, and keeps no per-terminal image transmission cache.
    expect(outcome.receipt.cold.rendererModes).toEqual([]);
    expect(outcome.receipt.cold.invalidatedImageIds).toEqual([]);
    expect(renderer.lastFrameReceipt().frameId).toBe(outcome.receipt.frameId);
    renderer.stop();
  });
});

describe("seam E: readiness and the host-facing presentation call", () => {
  seamIt("keeps the three phases distinct and gives a late registrant the snapshot", async () => {
    const ledger = new codingAgent.NativeReadinessLedger();
    ledger.record({ phase: "native-mounted" });
    ledger.record({ phase: "first-paint", presentationNonce: "frame-a" });

    const late = [];
    ledger.subscribe((entry) => late.push(entry.phase));
    expect(late).toEqual([]);
    expect(ledger.snapshot().reached.map((entry) => entry.phase)).toEqual(["native-mounted", "first-paint"]);

    ledger.record({ phase: "initialized" });
    expect(late).toEqual(["initialized"]);
    expect(ledger.record({ phase: "initialized" })).toBeUndefined();
    const firstPaint = ledger.reachedPhase("first-paint");
    expect(firstPaint.presentationNonce).toBe("frame-a");
    expect(ledger.reachedPhase("native-mounted").presentationNonce).toBeUndefined();
  });

  seamIt("drives a real renderer through presentTerminal and returns that frame's nonce", async () => {
    const { terminal, renderer } = startAltScreen({ columns: 52, rows: 9, children: [text("current ui")] });
    await nextFrames();
    codingAgent.setNativePresentationProvider({
      present: (request) => renderer.presentNow(request),
      release: () => undefined,
    });
    try {
      const before = terminal.writes.length;
      const result = await codingAgent.presentTerminal({
        attachmentEpoch: { attachmentId: "attach-1", epoch: 2 },
        geometryRevision: 5,
        coldTerminal: true,
      });
      expect(result.presented).toBe(true);
      expect(result.terminalOwner).toBe("pi");
      expect(result.presentationNonce).toBe(renderer.lastFrameReceipt().frameId);
      expect(result.frame.columns).toBe(52);
      expect(result.frame.rows).toBe(9);
      expect(result.geometryRevision).toBe(5);
      expect(result.coldReassertion.rendererModesReemitted).toContain("alt-screen");
      expect(terminal.since(before)).toContain(ENTER_ALT_SCREEN);
    } finally {
      codingAgent.setNativePresentationProvider(undefined);
      renderer.stop();
    }
  });

  seamIt("does not paint over a child-owned terminal and reports the acknowledgement as unavailable", async () => {
    const { terminal, renderer } = startAltScreen({ children: [text("current ui")] });
    await nextFrames();
    codingAgent.setNativePresentationProvider({
      present: (request) => renderer.presentNow(request),
      release: () => ({ owner: "child", reason: "external-editor", sinceMs: Date.now() }),
    });
    try {
      const before = terminal.writes.length;
      const result = await codingAgent.presentTerminal({
        attachmentEpoch: { attachmentId: "attach-1", epoch: 3 },
        geometryRevision: 6,
        coldTerminal: true,
      });
      expect(result.presented).toBe(false);
      expect(result.terminalOwner).toBe("child");
      expect(result.refusal).toBe("child-owns-terminal");
      expect(result.childAcknowledgement).toBe("unavailable");
      expect(result.presentationNonce).toBeNull();
      expect(terminal.since(before)).toBe("");
    } finally {
      codingAgent.setNativePresentationProvider(undefined);
      renderer.stop();
    }
  });

  seamIt("refuses an incompatible process record instead of resetting it", async () => {
    // The refusal is read on every call, not only at import, so planting a record this build cannot speak to
    // is enough to observe it through the installed module's own public surface.
    const key = Symbol.for("@earendil-works/pi-coding-agent/native-presentation-state");
    const real = globalThis[key];
    globalThis[key] = { version: 99 };
    try {
      expect(() => codingAgent.nativeReadinessSnapshot()).toThrow(/version 99 is already on this process/);
      expect(globalThis[key].version).toBe(99);
    } finally {
      globalThis[key] = real;
    }
  });

  seamIt("refuses with no provider registered", async () => {
    codingAgent.setNativePresentationProvider(undefined);
    const result = await codingAgent.presentTerminal({
      attachmentEpoch: { attachmentId: "attach-1", epoch: 1 },
      geometryRevision: 1,
      coldTerminal: false,
    });
    expect(result.presented).toBe(false);
    expect(result.refusal).toBe("no-native-renderer");
    expect(result.presentationNonce).toBeNull();
  });
});

/**
 * The installed bundled CLI, under a real pseudo-terminal, with a blocking `session_start` dialog in front
 * of initialization.
 *
 * This is the only case here that proves the launch-time route: the host learns `native-mounted` from the
 * core bootstrap sideband while an arbitrary extension's `session_start` handler is still awaiting an
 * answer, presents to that terminal over the same sideband, answers the dialog with a keystroke, and then
 * sees `first-paint` and `initialized` as separate records. No extension could have reported any of it.
 *
 * No provider is configured and every credential-shaped variable is stripped from the child's environment,
 * so no model call is reachable from this case at all.
 */
const harness = createRealProcessHarness("native-presentation-cli");

afterEach(() => harness.cleanup());

const cliIt = (name, body) =>
  it(
    name,
    async (context) => {
      if (!process.env.PI_SEAM_E_CONSUMER || !seamPresent) context.skip();
      await body();
    },
    240_000,
  );

function childEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (/API_KEY|_TOKEN$|CREDENTIAL|SECRET/i.test(key)) delete environment[key];
  }
  return environment;
}

/**
 * The whole terminal transcript and the exit result, saved rather than reduced to a boolean or a tail.
 *
 * Under the runner `os.tmpdir()` is this case's own preserved `tmp` directory, so the file outlives the run
 * while the harness's state root does not.
 */
async function saveTerminalAccounting(label, pty, exited) {
  const file = path.join(os.tmpdir(), `seam-e-${label}-terminal.json`);
  await writeFile(file, `${JSON.stringify({ label, exited, terminalOutput: pty.output() }, null, 2)}\n`);
  console.log(
    `seam E terminal accounting for ${label}: ${file}, ${pty.length()} bytes of terminal output, exit ${JSON.stringify(exited)}`,
  );
  return file;
}

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

describe("seam E: the installed bundled CLI and its core bootstrap", () => {
  /**
   * @param {"regular" | "fullscreen"} tuiMode which native renderer the CLI is started with. `regular` is
   * the shipped default, so it is the renderer a host actually attaches to unless the operator changed it.
   */
  const bootstrapCase = async (tuiMode) => {
    const root = await harness.stateRoot(`seam-e-cli-${tuiMode}-`);
    const agentDirectory = path.join(root, "agent");
    const extensions = path.join(agentDirectory, "extensions");
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    for (const directory of [extensions, project, home]) await mkdir(directory, { recursive: true });
    const gateAsked = path.join(root, "gate-asked");
    const gateAnswered = path.join(root, "gate-answered");
    const queuedExtensionReport = path.join(root, "queued-extension.json");

    await writeFile(
      path.join(extensions, "00-blocking-gate.ts"),
      `import { writeFileSync } from "node:fs";\n` +
        `export default function (pi) {\n` +
        `  pi.on("session_start", async (_event, ctx) => {\n` +
        `    writeFileSync(${JSON.stringify(gateAsked)}, "asked\\n");\n` +
        `    const answer = await ctx.ui.confirm("Startup gate", "Answer before initialization can finish");\n` +
        `    writeFileSync(${JSON.stringify(gateAnswered)}, String(answer) + "\\n");\n` +
        `  });\n` +
        `}\n`,
    );
    // A management extension queued behind that handler. It never runs while the gate is open, which is
    // exactly why the snapshot route cannot be the launch-time route.
    await writeFile(
      path.join(extensions, "10-queued-observer.ts"),
      `import { writeFileSync } from "node:fs";\n` +
        `export default function (pi) {\n` +
        `  pi.on("session_start", async () => {\n` +
        `    writeFileSync(${JSON.stringify(queuedExtensionReport)}, JSON.stringify(pi.nativeReadinessSnapshot()));\n` +
        `  });\n` +
        `}\n`,
    );

    const host = await startBootstrapHost();
    const cli = path.join(
      resolveInstalledPackageDirectory(installRoot, "@earendil-works/pi-coding-agent"),
      "dist/bundle/cli.js",
    );
    expect(existsSync(cli), `the installed bundled CLI is missing at ${cli}`).toBe(true);

    const pty = spawnPiUnderPty({
      command: `${process.execPath} ${cli} --tui-mode ${tuiMode}`,
      cwd: project,
      env: childEnvironment({
        HOME: home,
        PI_CODING_AGENT_DIR: agentDirectory,
        PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
        PI_NATIVE_BOOTSTRAP_SOCKET: host.socketPath,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        TERM: "xterm-256color",
        COLUMNS: "100",
        LINES: "30",
      }),
      transcriptPath: path.join(root, "transcript"),
    });
    const identity = await inspectProcessIdentity(pty.child.pid);
    await harness.record("pi under a pseudo-terminal", identity);

    let exited;
    try {
      const hello = await host.waitFor((frame) => frame.type === "native-bootstrap", "the bootstrap hello");
      expect(hello.capability.seam).toBe("E");
      expect(hello.protocol).toBe(1);
      expect(hello.pid).toBeGreaterThan(0);

      const mounted = await host.waitForPhase("native-mounted");
      expect(mounted.phase).toBe("native-mounted");
      // The dialog is drawn by the extension that blocks initialization.
      await pty.waitForText("Startup gate");

      // What the host knows while initialization is still held.
      expect(host.phases()).toContain("native-mounted");
      expect(host.phases()).not.toContain("initialized");
      expect(existsSync(gateAsked)).toBe(true);
      expect(existsSync(gateAnswered)).toBe(false);
      expect(
        existsSync(queuedExtensionReport),
        "an extension queued behind a blocking session_start handler reported nothing",
      ).toBe(false);

      // A client attaching at `native-mounted` asks for a cold presentation over the sideband alone.
      const beforePresent = pty.length();
      host.send({
        type: "present",
        protocol: 1,
        requestId: "host-cold-1",
        attachmentEpoch: { attachmentId: "cli-attach", epoch: 1 },
        geometryRevision: 3,
        coldTerminal: true,
      });
      const presented = await host.waitFor(
        (frame) => frame.type === "presentation-result" && frame.requestId === "host-cold-1",
        "the presentation result",
      );
      expect(presented.result.presented).toBe(true);
      expect(typeof presented.result.presentationNonce).toBe("string");
      expect(presented.result.geometryRevision).toBe(3);
      expect(presented.result.frame.columns).toBeGreaterThan(0);
      expect(presented.result.frame.byteLength).toBeGreaterThan(0);
      // The terminal's own modes are reasserted whichever renderer is mounted; only the fullscreen renderer
      // owns modes of its own.
      expect(presented.result.coldReassertion.terminalModesReemitted).toContain("bracketed-paste");
      expect(presented.result.coldReassertion.rendererModesReemitted).toEqual(
        tuiMode === "fullscreen" ? expect.arrayContaining(["alt-screen", "autowrap-off"]) : [],
      );
      // The frame reached this terminal: one synchronized-output frame carrying the blocking dialog, plus the
      // alt-screen entry when that is the renderer's own mode.
      await pty.waitUntil(
        (output) =>
          output.slice(beforePresent).includes("\x1b[?2026h") &&
          output.slice(beforePresent).includes("Startup gate") &&
          (tuiMode !== "fullscreen" || output.slice(beforePresent).includes("\x1b[?1049h")),
        "the presented frame on the terminal",
      );

      // The bundle's own inbound bound, not just the in-tree module's: a frame from another protocol version
      // is refused by version, and the channel keeps working afterwards.
      host.send({
        type: "present",
        protocol: 2,
        requestId: "host-future-1",
        attachmentEpoch: { attachmentId: "cli-attach", epoch: 1 },
        geometryRevision: 3,
        coldTerminal: true,
      });
      const refused = await host.waitFor(
        (frame) => frame.type === "error" && frame.requestId === "host-future-1",
        "the protocol refusal",
      );
      expect(refused.error).toContain("unsupported protocol 2");
      expect(refused.error).toContain("protocol 1");

      // Key input from `native-mounted`: Enter takes the highlighted answer.
      pty.write("\r");
      const initialized = await host.waitForPhase("initialized");
      expect(initialized.phase).toBe("initialized");
      expect((await readFile(gateAnswered, "utf8")).trim()).toBe("true");

      const mountedRecord = host.readiness("native-mounted");
      const firstPaint = host.readiness("first-paint");
      const initializedRecord = host.readiness("initialized");
      expect(firstPaint, "the first complete frame was reported").toBeDefined();
      expect(typeof firstPaint.presentationNonce).toBe("string");
      expect(mountedRecord.presentationNonce).toBeUndefined();
      expect(initializedRecord.presentationNonce).toBeUndefined();
      expect(new Set([mountedRecord.sequence, firstPaint.sequence, initializedRecord.sequence]).size).toBe(3);
      expect(mountedRecord.sequence).toBeLessThan(initializedRecord.sequence);

      // Once the gate is answered the queued extension finally runs, and reads the phases from the snapshot.
      await pty.waitUntil(() => existsSync(queuedExtensionReport), "the queued extension's own report");
      const queued = JSON.parse(await readFile(queuedExtensionReport, "utf8"));
      expect(queued.reached.map((entry) => entry.phase)).toContain("native-mounted");

      // Quit through the interface: Ctrl+D on an empty editor.
      pty.write("\x04");
      exited = await Promise.race([
        pty.exited(),
        new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "TIMEOUT" }), 20_000)),
      ]);
    } finally {
      await stopVerifiedProcessGroup(
        identity,
        { inspect: inspectProcessIdentity, requestGraceful: async () => {}, signalProcessGroup, sleep },
        { gracefulMs: 2_000, terminateMs: 2_000 },
      );
      await host.close();
    }

    // Recorded, not asserted: this case's subject is the sideband, and the terminal exit result has its own
    // bounded case below, which fails on a timeout, a signal or a nonzero code.
    await saveTerminalAccounting(`cli-${tuiMode}`, pty, exited ?? { code: null, signal: "NO EXIT OBSERVED" });
  };

  cliIt(
    "reports native-mounted before an extension can hide it, presents to the default main-screen terminal, and takes the answer to a blocking startup dialog",
    () => bootstrapCase("regular"),
  );

  cliIt(
    "does the same against the fullscreen renderer, which reasserts its own modes as well",
    () => bootstrapCase("fullscreen"),
  );

  /**
   * Two implementations of seam E in one process: the inlined bundle the agent runs, and the installed
   * module entry an in-process host imports.
   *
   * `node --import` is the supported route that puts them both there, and the preload is the only place a
   * second implementation can be loaded *before* the bundle creates the process record. A root re-export
   * query suffix would not do it: the package entry re-exports a fixed implementation URL, so Node hands
   * back the copy it already has. Readiness is recorded inside the bundle and read outside it; the provider
   * is registered inside the bundle and called from outside it.
   */
  cliIt("is reached across the bundle boundary by the installed module in the same process", async () => {
    const root = await harness.stateRoot("seam-e-preload-");
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    for (const directory of [project, home, path.join(root, "agent")]) await mkdir(directory, { recursive: true });

    const host = await startBootstrapHost();
    // The same newline-JSON listener, used here for the preload's single observation frame.
    const observer = await startBootstrapHost();
    const packageDirectory = resolveInstalledPackageDirectory(installRoot, "@earendil-works/pi-coding-agent");
    const cli = path.join(packageDirectory, "dist/bundle/cli.js");
    const installedEntry = resolveInstalledEntry(installRoot, "@earendil-works/pi-coding-agent");
    const preload = new URL("./fixtures/native-presentation/installed-module-preload.mjs", import.meta.url).href;
    expect(existsSync(cli), `the installed bundled CLI is missing at ${cli}`).toBe(true);
    // Two different implementation files, which is what makes this a boundary at all.
    expect(cli.endsWith("dist/bundle/cli.js")).toBe(true);
    expect(installedEntry.endsWith("dist/index.js")).toBe(true);

    const pty = spawnPiUnderPty({
      command: `${process.execPath} --import ${preload} ${cli} --tui-mode regular`,
      cwd: project,
      env: childEnvironment({
        HOME: home,
        PI_CODING_AGENT_DIR: path.join(root, "agent"),
        PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
        PI_NATIVE_BOOTSTRAP_SOCKET: host.socketPath,
        PI_SEAM_E_PRELOAD_ENTRY: installedEntry,
        PI_SEAM_E_PRELOAD_SOCKET: observer.socketPath,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        TERM: "xterm-256color",
        COLUMNS: "100",
        LINES: "30",
      }),
      transcriptPath: path.join(root, "transcript"),
    });
    const identity = await inspectProcessIdentity(pty.child.pid);
    await harness.record("pi with the installed module preloaded", identity);

    let exited;
    try {
      await host.waitFor((frame) => frame.type === "native-bootstrap", "the bootstrap hello");
      const observation = await observer.waitFor(
        (frame) => frame.type === "preload-observation",
        "the preloaded installed module's observation",
      );

      expect(observation.error, "the preloaded installed module reported no failure").toBeUndefined();
      expect(observation.imported).toBe(true);
      expect(observation.stateVersion).toBe(codingAgent.NATIVE_PRESENTATION_STATE_VERSION);
      // The preload loaded first, so the record on the process is the one it constructed.
      expect(observation.ledgerIsThisCopys).toBe(true);
      // Recorded inside the bundle, delivered to the other implementation as an event and in its snapshot.
      expect(observation.phases).toContain("native-mounted");
      expect(observation.snapshotPhases).toContain("native-mounted");
      // Registered inside the bundle by `InteractiveMode`, called through the installed module.
      expect(observation.presentation.presented, JSON.stringify(observation.presentation)).toBe(true);
      expect(typeof observation.presentation.presentationNonce).toBe("string");
      expect(observation.presentation.geometryRevision).toBe(41);
      expect(observation.presentation.frame.byteLength).toBeGreaterThan(0);
      // The out-of-process host saw the same mount over the sideband.
      expect(host.phases()).toContain("native-mounted");

      pty.write("\x04");
      exited = await exitWithin(pty, "the preloaded CLI", 30_000);
    } finally {
      await stopVerifiedProcessGroup(
        identity,
        { inspect: inspectProcessIdentity, requestGraceful: async () => {}, signalProcessGroup, sleep },
        { gracefulMs: 2_000, terminateMs: 2_000 },
      );
      await host.close();
      await observer.close();
    }
    await saveTerminalAccounting("cli-preload", pty, exited);
    expect(exited).toEqual({ code: 0, signal: null });
  });

  /**
   * The inbound bound, over the real sideband, against the provider the running CLI actually registered.
   *
   * The in-tree suite measures the same rule against a fake provider; this case measures it where a breach
   * would really reach `InteractiveMode` and really paint. A whitespace-padded frame is the interesting shape:
   * its trimmed text is a couple of hundred bytes, its raw bytes are past the bound, and the bound is declared
   * on the raw frame. A valid command rides behind it in the same write, and a second valid command arrives
   * afterwards as its own data event, so both the already-buffered and the later route are covered.
   */
  cliIt("refuses a whitespace-padded frame by its raw bytes and reaches no provider after the breach", async () => {
    const root = await harness.stateRoot("seam-e-bound-");
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    for (const directory of [project, home, path.join(root, "agent")]) await mkdir(directory, { recursive: true });
    const cli = path.join(
      resolveInstalledPackageDirectory(installRoot, "@earendil-works/pi-coding-agent"),
      "dist/bundle/cli.js",
    );
    const bound = codingAgent.NATIVE_BOOTSTRAP_MAX_COMMAND_BYTES;
    expect(typeof bound, "the installed module publishes the bound a host is held to").toBe("number");

    const host = await startBootstrapHost();
    const pty = spawnPiUnderPty({
      command: `${process.execPath} ${cli} --tui-mode regular`,
      cwd: project,
      env: childEnvironment({
        HOME: home,
        PI_CODING_AGENT_DIR: path.join(root, "agent"),
        PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
        PI_NATIVE_BOOTSTRAP_SOCKET: host.socketPath,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        TERM: "xterm-256color",
        COLUMNS: "100",
        LINES: "30",
      }),
      transcriptPath: path.join(root, "transcript"),
    });
    const identity = await inspectProcessIdentity(pty.child.pid);
    await harness.record("pi under a bounded sideband", identity);

    let exited;
    try {
      await host.waitFor((frame) => frame.type === "native-bootstrap", "the bootstrap hello");
      // The provider only exists once the native UI is mounted, so a breach after this point is a breach that
      // could have painted.
      await host.waitForPhase("native-mounted");

      const command = (requestId, geometryRevision) =>
        JSON.stringify({
          type: "present",
          protocol: 1,
          requestId,
          attachmentEpoch: { attachmentId: "attach-bound", epoch: 1 },
          geometryRevision,
          coldTerminal: true,
        });
      const padded = command("host-padded-1", 21);
      const padding = " ".repeat(bound + 512 - Buffer.byteLength(padded) - 1);
      expect(Buffer.byteLength(`${padded}${padding}\n`)).toBe(bound + 512);
      expect(Buffer.byteLength(padded)).toBeLessThan(bound);

      // One write: the padded breach, and a valid command already buffered behind it.
      host.sendRaw(`${padded}${padding}\n${command("host-after-breach-1", 22)}\n`);
      const refused = await host.waitFor((frame) => frame.type === "error", "the refusal naming the bound", 20_000);
      expect(refused.error).toContain(`${bound} byte bound`);
      expect(refused.error).toContain("channel is closed");

      // A later data event, after the refusal was answered and the channel closed.
      host.sendRaw(`${command("host-after-breach-2", 23)}\n`);
      await expect(
        host.waitFor((frame) => frame.type === "presentation-result", "a presentation result after the breach", 3_000),
      ).rejects.toThrow(/no a presentation result after the breach frame arrived/);
      expect(
        host.frames.filter((frame) => frame.type === "presentation-result"),
        "nothing behind the breach was presented",
      ).toEqual([]);

      pty.write("\x04");
      exited = await exitWithin(pty, "the bounded-sideband CLI", 30_000);
    } finally {
      await stopVerifiedProcessGroup(
        identity,
        { inspect: inspectProcessIdentity, requestGraceful: async () => {}, signalProcessGroup, sleep },
        { gracefulMs: 2_000, terminateMs: 2_000 },
      );
      await host.close();
    }
    await saveTerminalAccounting("cli-inbound-bound", pty, exited);
    expect(exited).toEqual({ code: 0, signal: null });
  });

  /**
   * The lifecycle claim, asserted against a sideband that really connected: an unreferenced, *open* socket
   * whose hello the host already has does not hold Pi open.
   *
   * `config --help` is the one bundled command that returns from `main()` instead of calling `process.exit`,
   * so the process ends only when its own event loop drains — which is exactly what a referenced socket would
   * prevent while the host's listener stayed open. Returning from `main()` alone, though, does not prove the
   * child ever connected: `net.connect` is asynchronous and unreferenced, so the run could end first and the
   * case would only measure a configured connect attempt.
   *
   * `bootstrap-gate-preload.mjs` closes that gap with test-owned liveness and nothing else. It holds one
   * referenced timer past the return of `main()` until the installed module's own `nativeBootstrapStatus()`
   * reports `open` with the hello written, then clears the timer and destroys its single report socket as soon
   * as that report flushes. No production keepalive is added and no `process.exit` is forced.
   *
   * What the managed run therefore proves: the host holds the hello from this pid, the gate confirmed `open`,
   * every test-owned handle was released, and the process still exited `0` with the listener still live. The
   * unmanaged run beside it keeps the failure attributable. A timeout, a signal or a nonzero code fails this.
   */
  cliIt("exits normally with an open, hello-delivered sideband, because that socket is unreferenced", async () => {
    const root = await harness.stateRoot("seam-e-lifecycle-");
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    for (const directory of [project, home, path.join(root, "agent")]) await mkdir(directory, { recursive: true });
    const cli = path.join(
      resolveInstalledPackageDirectory(installRoot, "@earendil-works/pi-coding-agent"),
      "dist/bundle/cli.js",
    );
    const installedEntry = resolveInstalledEntry(installRoot, "@earendil-works/pi-coding-agent");
    const preload = new URL("./fixtures/native-presentation/bootstrap-gate-preload.mjs", import.meta.url).href;
    const host = await startBootstrapHost();
    // The gate's own listener, so its record arrives as a frame rather than a polled file.
    const gate = await startBootstrapHost();

    const runConfigHelp = async (label, sidebandSocket) => {
      const gated = sidebandSocket !== undefined;
      const pty = spawnPiUnderPty({
        command: gated
          ? `${process.execPath} --import ${preload} ${cli} config --help`
          : `${process.execPath} ${cli} config --help`,
        cwd: project,
        env: childEnvironment({
          HOME: home,
          PI_CODING_AGENT_DIR: path.join(root, "agent"),
          PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
          ...(gated
            ? {
                PI_NATIVE_BOOTSTRAP_SOCKET: sidebandSocket,
                PI_SEAM_E_GATE_ENTRY: installedEntry,
                PI_SEAM_E_GATE_SOCKET: gate.socketPath,
                PI_SEAM_E_GATE_DEADLINE_MS: "20000",
              }
            : {}),
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          TERM: "xterm-256color",
          COLUMNS: "100",
          LINES: "30",
        }),
        transcriptPath: path.join(root, `transcript-${label}`),
      });
      const identity = await inspectProcessIdentity(pty.child.pid);
      await harness.record(`pi config --help ${label}`, identity);
      let exited;
      try {
        exited = await exitWithin(pty, `\`pi config --help\` ${label}`, 60_000);
      } finally {
        await stopVerifiedProcessGroup(
          identity,
          { inspect: inspectProcessIdentity, requestGraceful: async () => {}, signalProcessGroup, sleep },
          { gracefulMs: 2_000, terminateMs: 2_000 },
        );
      }
      await saveTerminalAccounting(`config-help-${label}`, pty, exited);
      return { exited, output: pty.output() };
    };

    try {
      // Without the sideband: this command drains its own event loop, so a failure below is the seam's.
      const unmanaged = await runConfigHelp("unmanaged", undefined);
      expect(unmanaged.exited).toEqual({ code: 0, signal: null });

      const managed = await runConfigHelp("with-sideband", host.socketPath);
      // The run reached `startNativeBootstrapChannel`: this help text is printed after it.
      expect(managed.output).toContain("Open the resource configuration TUI");

      const observation = await gate.waitFor((frame) => frame.type === "gate-observation", "the gate's record");
      expect(observation.error, "the gate loaded the installed module and read its status").toBeUndefined();
      // The channel was open, with the hello already written, before the gate let go of the process.
      expect(observation.state).toBe("open");
      expect(observation.released).toBe(true);
      expect(observation.expired).toBe(false);
      expect(observation.framesSent).toBeGreaterThanOrEqual(1);

      const hello = await host.waitFor((frame) => frame.type === "native-bootstrap", "the bootstrap hello");
      // The same process: the connection the host accepted belongs to the run that then exited.
      expect(hello.pid).toBe(observation.pid);
      expect(managed.exited).toEqual({ code: 0, signal: null });
    } finally {
      await gate.close();
      await host.close();
    }
  });
});
