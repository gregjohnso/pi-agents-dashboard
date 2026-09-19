/**
 * The Pi-side half of the host's labelled-ingress route, loaded into the real bundled CLI with `--import`.
 *
 * Why this file exists at all: `nativeInputTargetSnapshot` and `subscribeNativeInputTarget` read a container
 * that lives **inside this process**. A host in another process cannot call them, and nothing here pretends
 * otherwise — this copy runs where the registry is, and relays two things over one versioned test socket:
 *
 *   1. the facts of every publication it observes, exactly as the public snapshot reports them, and
 *   2. one `dispatchNativeInput` call per host command, answered with that call's own real result.
 *
 * It is test infrastructure for qualification. It is not product wiring, it is not a shared registry, and it
 * dispatches nothing of its own: every labelled span it hands to Pi came from the host process.
 *
 * `--import` runs before the CLI's main entry, so the attachment host is registered here — before the
 * renderer's startup capability query — rather than from a publication callback after `start()` has already
 * negotiated. That ordering is the point: a launch-fixed profile has to be registered before the queries it is
 * supposed to fix.
 *
 * Inputs: `HOST_RELAY_SOCKET`, `HOST_RELAY_PROTOCOL`, `HOST_RELAY_TUI_PACKAGE`, `HOST_RELAY_PROFILE` and
 * `HOST_RELAY_LOG`.
 */

import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const socketPath = process.env.HOST_RELAY_SOCKET;
const declaredProtocol = Number(process.env.HOST_RELAY_PROTOCOL);
const tuiPackageRoot = process.env.HOST_RELAY_TUI_PACKAGE;
const logPath = process.env.HOST_RELAY_LOG;
const profileJson = process.env.HOST_RELAY_PROFILE;

if (!socketPath || !tuiPackageRoot || !logPath || !profileJson) {
  throw new Error("HOST_RELAY_SOCKET, HOST_RELAY_TUI_PACKAGE, HOST_RELAY_PROFILE and HOST_RELAY_LOG are required");
}
if (declaredProtocol !== 1) {
  // One version, refused rather than guessed: a drifted fixture must fail loudly instead of half-working.
  throw new Error(`this relay speaks protocol 1, not ${process.env.HOST_RELAY_PROTOCOL}`);
}

let order = 0;
function record(event) {
  order += 1;
  appendFileSync(logPath, `${JSON.stringify({ order, pid: process.pid, ...event })}\n`);
}

const require = createRequire(path.join(tuiPackageRoot, "package.json"));
const tui = await import(`file://${require.resolve(tuiPackageRoot)}`);

record({
  event: "loaded",
  node: process.version,
  apiVersion: tui.NATIVE_INPUT_TARGET_API_VERSION ?? null,
  hasSnapshot: typeof tui.nativeInputTargetSnapshot === "function",
  hasSubscribe: typeof tui.subscribeNativeInputTarget === "function",
  hasRegister: typeof tui.registerNativeAttachmentHost === "function",
});

if (typeof tui.subscribeNativeInputTarget !== "function" || typeof tui.registerNativeAttachmentHost !== "function") {
  record({ event: "unavailable", reason: "the installed pi-tui publishes no native input target" });
} else {
  /**
   * The launch-fixed profile, registered now — before `ProcessTerminal.start()` runs its startup queries.
   *
   * Every capability the host declared is declared here, images included. A qualification that turned a
   * feature off to make its own profile pass would proves nothing about launch-fixed enforcement.
   */
  const profile = JSON.parse(profileJson);
  const registration = tui.registerNativeAttachmentHost({
    profile,
    authorizeReturn: () => "native",
    beforeApplyTerminalResponse: async (response) => {
      // The host decides terminal responses. This side records what it was asked and refuses to apply, which
      // is what a launch-fixed profile means: nothing an attaching client replies can move it.
      record({ event: "terminalResponse", kind: response?.kind ?? null, requestEpoch: response?.requestEpoch ?? null });
      return { apply: false };
    },
  });
  record({
    event: "hostRegistered",
    beforeStartup: true,
    released: typeof registration?.release === "function",
    profileId: tui.getVirtualTerminalProfile?.()?.profileId ?? null,
    kittyGraphics: tui.getVirtualTerminalProfile?.()?.capabilities?.kittyGraphics ?? null,
    kittyKeyboard: tui.getVirtualTerminalProfile?.()?.capabilities?.kittyKeyboard ?? null,
    mouse: tui.getVirtualTerminalProfile?.()?.capabilities?.mouse ?? null,
  });

  /** @type {net.Socket | null} */
  let peer = null;
  const send = (frame) => {
    if (peer === null || peer.destroyed) return;
    peer.write(`${JSON.stringify({ relayProtocol: 1, ...frame })}\n`);
  };

  const publish = (snapshot, label) => {
    record({
      event: "publication",
      label,
      publicationId: snapshot.publication?.publicationId ?? null,
      sequence: snapshot.publication?.sequence ?? null,
      producerVersion: snapshot.producerVersion,
      reason: snapshot.reason,
      hasTarget: snapshot.target !== null,
    });
    send({
      type: "publication",
      label,
      apiVersion: snapshot.apiVersion,
      producerVersion: snapshot.producerVersion,
      publication: snapshot.publication,
      reason: snapshot.reason,
      hasTarget: snapshot.target !== null,
    });
  };

  const { snapshot: first } = tui.subscribeNativeInputTarget((next) => publish(next, "subscription"));
  publish(first, "initial");

  peer = net.connect(socketPath);
  peer.on("error", (error) => record({ event: "relayError", error: String(error?.message ?? error) }));
  peer.on("connect", () => {
    record({ event: "relayConnected" });
    // The host learns the state as it is now, so it never has to assume a transition it did not see.
    publish(tui.nativeInputTargetSnapshot(), "connected");
  });

  let buffered = "";
  peer.setEncoding("utf8");
  peer.on("data", (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (line.trim().length === 0) continue;
      const command = JSON.parse(line);
      if (command.relayProtocol !== 1 || command.type !== "dispatch") {
        send({ type: "dispatch-result", requestId: command.requestId ?? null, failed: true, error: `unsupported relay frame ${String(command.type)}` });
        continue;
      }
      // Read the registry fresh for every dispatch: the handle a host cached may have been revoked or rotated,
      // and the published contract's own staleness guard is what makes that safe.
      const current = tui.nativeInputTargetSnapshot();
      if (current.target === null) {
        record({ event: "dispatchRefused", requestId: command.requestId, reason: current.reason });
        send({ type: "dispatch-result", requestId: command.requestId, result: { admitted: false, reason: "target-revoked" } });
        continue;
      }
      const bytes = new Uint8Array(Buffer.from(String(command.bytesBase64), "base64"));
      current.target
        .dispatchNativeInput({ attachmentEpoch: command.attachmentEpoch, bytes, binding: command.binding })
        .then((result) => {
          record({
            event: "dispatched",
            requestId: command.requestId,
            attachmentEpoch: command.attachmentEpoch,
            byteLength: bytes.byteLength,
            admitted: result?.admitted === true,
            reason: result?.reason ?? null,
            consumedThrough: result?.consumedThrough ?? null,
            publicationId: current.publication?.publicationId ?? null,
          });
          send({ type: "dispatch-result", requestId: command.requestId, result });
        })
        .catch((error) => {
          record({ event: "dispatchFailed", requestId: command.requestId, error: String(error?.message ?? error) });
          send({ type: "dispatch-result", requestId: command.requestId, failed: true, error: String(error?.message ?? error) });
        });
    }
  });
}
