/**
 * The demo's pre-TUI caller, loaded into the real Pi process with `node --import`.
 *
 * It runs before the bundled CLI's entry module, so it registers the native attachment host before Pi writes
 * its first capability query. That ordering is the reason this is a preload and not part of the extension:
 * **the pre-TUI registration owns the launch-fixed terminal profile**, and a host that arrived after
 * negotiation could only guess at it.
 *
 * It deliberately imports the *installed* `@earendil-works/pi-tui` from the selected cohort rather than the
 * copy the bundle inlined. Those are two module instances in one process; the seam's registration lives in a
 * versioned container on the process, so the host registered here is the host the bundle's own instance
 * consults.
 *
 * The bytes it dispatches come from the manager over an authenticated socket, labelled with the attachment
 * epoch the manager assigned. This file never classifies a key, never decodes an escape sequence and never
 * looks at rendered output: it hands Pi bytes and Pi decides what they are.
 *
 * Required environment, all private to this process:
 *   PI_DEMO_TUI_PACKAGE     installed @earendil-works/pi-tui package root, from the selected cohort
 *   PI_DEMO_CONTROL_SOCKET  the manager's control socket
 *   PI_DEMO_TOKEN           the manager's connection token
 *   PI_DEMO_PROFILE         the launch-fixed VirtualTerminalProfile, as JSON
 *   PI_DEMO_LOG             JSONL file this caller appends its observations to
 *
 * Nothing is written to stdout or stderr: those are Pi's terminal.
 */

import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

import { createFrameReader, encodeFrame } from "./protocol.mjs";
import { awaitTui } from "./tui-handover.mjs";

const logPath = process.env.PI_DEMO_LOG;
const packageRoot = process.env.PI_DEMO_TUI_PACKAGE;
const socketPath = process.env.PI_DEMO_CONTROL_SOCKET;
const token = process.env.PI_DEMO_TOKEN;
const profileJson = process.env.PI_DEMO_PROFILE;

if (!logPath || !packageRoot || !socketPath || !token || !profileJson) {
  throw new Error("PI_DEMO_LOG, PI_DEMO_TUI_PACKAGE, PI_DEMO_CONTROL_SOCKET, PI_DEMO_TOKEN and PI_DEMO_PROFILE are required");
}

/** @param {Record<string, unknown>} event */
function record(event) {
  try {
    appendFileSync(logPath, `${JSON.stringify({ atMs: Date.now(), ...event })}\n`);
  } catch {
    // A log that cannot be written must not take Pi down.
  }
}

const require = createRequire(path.join(packageRoot, "package.json"));
const installedTuiEntry = require.resolve(packageRoot);
const tui = await import(`file://${installedTuiEntry}`);

if (typeof tui.registerNativeAttachmentHost !== "function") {
  throw new Error(`the installed ${packageRoot} exposes no registerNativeAttachmentHost`);
}

const profile = JSON.parse(profileJson);
const registration = tui.registerNativeAttachmentHost({
  profile,
  // Seam G, explicitly and by version: this caller has a drain boundary to act on and a phase listener.
  childTerminalHandoff: { version: tui.SUPPORTED_CHILD_TERMINAL_HANDOFF_VERSION },
  authorizeReturn: (/** @type {any} */ request) => {
    // The default editor owns the return key, so Pi does not ask. A host that answered anything but
    // "native" here would be claiming a gesture it was never offered; the demo's detach is the manager's
    // explicit control command instead.
    record({ event: "authorizeReturn", sequenceId: request.sequenceId, origin: request.origin, decision: "native" });
    return "native";
  },
  beforeApplyTerminalResponse: (/** @type {any} */ response) => {
    // The profile is launch-fixed. A client that attached after negotiation must not move Pi's capability
    // state, so its reply is consumed and nothing is applied.
    record({
      event: "beforeApplyTerminalResponse",
      kind: response.kind,
      requestEpoch: response.requestEpoch,
      attachmentEpoch: response.attachmentEpoch,
      raw: Buffer.from(response.raw).toString("latin1"),
      apply: false,
    });
    return Promise.resolve({ apply: false });
  },
});

record({
  event: "registered",
  pid: process.pid,
  node: process.version,
  installedTuiEntry,
  profileId: tui.getVirtualTerminalProfile()?.profileId ?? null,
  hostVisibleFromInstalledInstance: tui.getNativeAttachmentHost() !== undefined,
  childTerminalHandoffActive: tui.isChildTerminalHandoffActive?.() ?? false,
});

const connection = net.connect(socketPath);
// The channel must never be the reason Pi stays alive, and a broken manager must never crash Pi.
connection.unref();
connection.on("error", (error) => record({ event: "channelError", message: error.message }));

/** @type {any} */
let terminal;
/** Reporting order is dispatch order: admission is synchronous, so the chain only orders the answers. */
let reporting = Promise.resolve();

const send = (/** @type {Record<string, unknown>} */ header, /** @type {Uint8Array} */ body) => {
  if (connection.destroyed) return;
  try {
    connection.write(encodeFrame(header, body));
  } catch (error) {
    record({ event: "sendFailed", message: /** @type {Error} */ (error).message });
  }
};

tui.onChildTerminalPhase?.((/** @type {any} */ phase) => {
  record({ event: "childTerminalPhase", ...phase });
  send({ type: "child-terminal-phase", phase });
});

const reader = createFrameReader(
  ({ header, body }) => {
    if (header.type === "input") {
      if (!terminal) {
        // The manager only forwards after `ingress-ready`, so this is a protocol fault, not a race.
        send({ type: "input-result", sequence: header.sequence, admitted: false, reason: "ingress-not-ready" });
        return;
      }
      const dispatch = terminal.dispatchNativeInput({
        attachmentEpoch: { attachmentId: header.attachmentId, epoch: header.epoch },
        bytes: new Uint8Array(body),
        binding: { generation: header.generation },
      });
      reporting = reporting.then(async () => {
        try {
          const result = await dispatch;
          send({ type: "input-result", sequence: header.sequence, ...result });
        } catch (error) {
          record({ event: "dispatchFailed", sequence: header.sequence, message: /** @type {Error} */ (error).message });
          send({ type: "input-result", sequence: header.sequence, admitted: false, reason: "dispatch-failed" });
        }
      });
      return;
    }
    record({ event: "unknownFrame", frameType: header.type });
  },
  (error) => {
    record({ event: "channelRefused", code: error.code, message: error.message });
    connection.destroy();
  },
);
connection.on("data", (chunk) => reader.push(chunk));

connection.on("connect", () => {
  send({ type: "hello", role: "ingress", token, pid: process.pid });
  void awaitTui().then((publicTui) => {
    terminal = publicTui.terminal;
    const hasDispatch = typeof terminal?.dispatchNativeInput === "function";
    record({ event: "tuiHandover", mode: publicTui.mode, hasDispatch });
    if (!hasDispatch) {
      send({ type: "ingress-unavailable", reason: "the public terminal exposes no dispatchNativeInput" });
      return;
    }
    send({ type: "ingress-ready", pid: process.pid, tuiMode: publicTui.mode });
  });
});

process.on("exit", () => {
  registration.release();
});
