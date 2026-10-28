/**
 * The host side of seam E's core bootstrap sideband.
 *
 * Pi connects out to this listener from `main()`, before any extension module is loaded, and writes its hello
 * first. That is the only launch-time route to readiness and cold presentation: an extension's
 * `session_start` runs later and behind every other extension's handler, so a host that waited for one could
 * be held up by code it does not own.
 *
 * Reads are bounded the same way Pi bounds its own inbound side: one newline-terminated JSON object of at
 * most `MAX_LINE_BYTES`. A peer that crosses the bound ends the channel instead of being buffered. There is
 * no reconnect logic, because Pi connects once per launch.
 *
 * **Pi connects once, but Pi's DESCENDANTS also can, and that is what this listener has to survive.** Because
 * the channel is unauthenticated, any process that inherited the environment naming this socket may open it - a
 * spawned tool included. This listener used to make the newest connection the peer unconditionally, so a
 * short-lived descendant displaced the owner's connection and then exited, leaving a perfectly healthy running
 * session with no route to a cold presentation and therefore no way to repaint on a later attach. Two rules
 * follow, and neither invents a credential this protocol does not have:
 *
 *   1. a connection is a CANDIDATE until its own `native-bootstrap` hello identifies it as the owner, and
 *   2. a live peer is never displaced.
 *
 * A candidate's frames reach nobody, so a descendant's hello can no longer be recorded as the owner's readiness
 * or answer a presentation in the owner's place. Buffers are per connection, so two peers' partial writes cannot
 * be reassembled into one another's frames.
 *
 * **This channel is not authenticated, and it must not be described as if it were.** Protocol 1 is Pi's own,
 * unchanged, and it carries no credential field; this demo adds none and invents no core protocol field. The
 * only thing standing between this listener and another process is filesystem permission: the socket is
 * unix-domain, `0600`, inside the owner's `0700` root. The demo's *own* control socket in `manager.mjs` is the
 * one that requires a token. Keep the two straight when reasoning about who can reach what.
 */

import { chmod, rm } from "node:fs/promises";
import net from "node:net";

const MAX_LINE_BYTES = 8 * 1024;
const PRESENT_TIMEOUT_MS = 10_000;
/**
 * The unresolved-identity window, and why it is a deferral rather than a default.
 *
 * This listener is created before Pi is spawned, and the manager can only name the owner once `openOwnerPty` has
 * spawned it and read its birth proc snapshot - so a hello can genuinely arrive while the owner's identity is
 * still unknown. Neither shortcut is acceptable: treating unknown identity as a wildcard lets whoever arrives
 * first take the slot, and refusing outright loses the real owner permanently, because Pi connects exactly once
 * per launch. So a claim made in that window is HELD and settled by claimed pid once identity resolves, bounded
 * by a deadline, a claimant count and a queue length - no polling and nothing that grows without limit.
 */
const IDENTITY_WAIT_MS = 30_000;
/** Frames one pending claimant may send behind its hello before the decision is made. */
const MAX_PENDING_FRAMES = 8;
/** Connections that may hold an undecided claim at once, so a race in the window still resolves. */
const MAX_PENDING_CLAIMANTS = 4;

/**
 * @param {string} socketPath
 * @param {{ onFrame: (frame: any) => void, onError: (error: Error) => void }} handlers
 */
export async function startBootstrapSideband(socketPath, { onFrame, onError, whenOwnerPid, identityDeadlineMs = IDENTITY_WAIT_MS }) {
  /** @type {net.Socket | undefined} */
  let peer;
  let requestCounter = 0;
  /** Connections that spoke but never identified as the owner. Bounded counters, for visibility. */
  const refused = { candidates: 0, displacementsPrevented: 0, foreignFrames: 0, identityUnresolved: 0 };
  /** The owner's pid once the manager has identified it. `undefined` means "not yet", never "anyone". */
  let ownerPid;
  /** @type {Set<{ hello: any, queued: any[], adopt: (why: string) => void, reject: (why: string) => void }>} */
  const claimants = new Set();

  // One bounded wait on the manager's own lifecycle promise. Settling it decides every held claim at once.
  const identity = Promise.race([
    Promise.resolve(whenOwnerPid).then((pid) => {
      if (typeof pid !== "number") throw new Error(`The bootstrap sideband was given no owner pid to check helloes against, so no claim can be settled`);
      return pid;
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`The owner's identity did not resolve within ${identityDeadlineMs}ms, so no bootstrap claim could be settled`)), identityDeadlineMs).unref();
    }),
  ]);
  void identity.then(
    (pid) => {
      ownerPid = pid;
      // Exactly one held claim can be the owner; the rest are refused by pid, not by arrival order.
      for (const claimant of [...claimants]) {
        if (claimant.hello.pid === pid && (peer === undefined || peer.destroyed)) claimant.adopt(`identified as the owner ${pid}`);
        else claimant.reject(`hello reports pid ${claimant.hello.pid}, not the owner's ${pid}`);
      }
    },
    (error) => {
      for (const claimant of [...claimants]) claimant.reject(error.message);
      onError(error);
    },
  );
  /** @type {Map<string, { resolve: (result: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();

  const settle = (requestId, outcome) => {
    const waiter = pending.get(requestId);
    if (!waiter) return;
    pending.delete(requestId);
    clearTimeout(waiter.timer);
    if (outcome instanceof Error) waiter.reject(outcome);
    else waiter.resolve(outcome);
  };

  const server = net.createServer((connection) => {
    // Per connection, so two peers' partial writes are never reassembled into one another's frames.
    let buffered = "";
    /** "new" before a hello, "pending" while the decision is held, "owner" once adopted, "refused" when done. */
    let state = "new";
    /** @type {any[]} */
    const queued = [];

    const deliver = (frame) => {
      if (frame?.type === "presentation-result") settle(frame.requestId, frame.result);
      else if (frame?.type === "error") settle(frame.requestId, new Error(`Pi refused a sideband frame: ${JSON.stringify(frame.error)}`));
      onFrame(frame);
    };

    /** @type {{ hello: any, queued: any[], adopt: (why: string) => void, reject: (why: string) => void }} */
    const claim = {
      hello: undefined,
      queued,
      adopt(why) {
        claimants.delete(claim);
        if (state !== "pending") return;
        state = "owner";
        peer = connection;
        // The hello and everything that arrived behind it, in the order Pi wrote them.
        deliver(claim.hello);
        for (const frame of queued.splice(0)) deliver(frame);
        void why;
      },
      reject(why) {
        claimants.delete(claim);
        if (state === "refused" || state === "owner") return;
        state = "refused";
        refused.candidates += 1;
        queued.length = 0;
        onError(new Error(`The bootstrap sideband refused a connection: ${why}`));
        connection.destroy();
      },
    };

    const refuseNow = (message, counter) => {
      state = "refused";
      claimants.delete(claim);
      refused[counter] += 1;
      onError(new Error(message));
      connection.destroy();
    };

    connection.setEncoding("utf8");
    connection.on("error", (error) => onError(error));
    connection.on("close", () => {
      claimants.delete(claim);
      if (peer === connection) peer = undefined;
    });
    connection.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE_BYTES) {
        onError(new Error(`The bootstrap sideband peer buffered ${buffered.length} bytes without a newline, above ${MAX_LINE_BYTES}`));
        buffered = "";
        connection.destroy();
        return;
      }
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (line.trim() === "") continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch (cause) {
          onError(new Error(`The bootstrap sideband sent a line that is not JSON: ${/** @type {Error} */ (cause).message}`));
          continue;
        }
        if (state === "refused") continue;
        if (state === "owner") {
          deliver(frame);
          continue;
        }
        if (state === "pending") {
          // Held, in order, and bounded. Pi sends one hello and then readiness, so this stays tiny in practice.
          if (queued.length >= MAX_PENDING_FRAMES) {
            refuseNow(`A pending bootstrap claimant queued more than ${MAX_PENDING_FRAMES} frames before its identity could be settled`, "identityUnresolved");
            return;
          }
          queued.push(frame);
          continue;
        }
        // state === "new": only a hello can start a claim. Anything else is nobody's readiness.
        if (frame?.type !== "native-bootstrap") {
          refused.foreignFrames += 1;
          continue;
        }
        if (peer !== undefined && !peer.destroyed && peer !== connection) {
          refuseNow(`The bootstrap sideband refused a second connection (hello pid ${frame.pid}) because the owner's connection is live`, "displacementsPrevented");
          return;
        }
        if (ownerPid !== undefined) {
          // Identity is known, so the answer is immediate.
          if (frame.pid !== ownerPid) {
            refuseNow(`The bootstrap sideband refused a connection whose hello reports pid ${frame.pid}, not the owner's ${ownerPid}`, "candidates");
            return;
          }
          state = "owner";
          peer = connection;
          deliver(frame);
          continue;
        }
        // Identity is NOT known yet. Hold the claim - never grant it by default - and let `identity` settle it.
        if (claimants.size >= MAX_PENDING_CLAIMANTS) {
          refuseNow(`The bootstrap sideband already holds ${claimants.size} undecided claims, which is its bound`, "identityUnresolved");
          return;
        }
        state = "pending";
        claim.hello = frame;
        claimants.add(claim);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  await chmod(socketPath, 0o600);

  return {
    connected() {
      return peer !== undefined && !peer.destroyed;
    },
    /** What this listener turned away, so a refusal is visible rather than silent. */
    refusals() {
      return { ...refused };
    },
    /**
     * Ask Pi for one cold presentation and resolve with its own `PresentTerminalResult`.
     *
     * @param {{ attachmentId: string, epoch: number, geometryRevision: number }} request
     */
    present({ attachmentId, epoch, geometryRevision }) {
      if (!peer || peer.destroyed) return Promise.reject(new Error("Pi has not connected to the bootstrap sideband"));
      requestCounter += 1;
      const requestId = `present-${requestCounter}`;
      const command = {
        type: "present",
        protocol: 1,
        requestId,
        attachmentEpoch: { attachmentId, epoch },
        geometryRevision,
        coldTerminal: true,
      };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(requestId, new Error(`Pi did not answer ${requestId} within ${PRESENT_TIMEOUT_MS}ms`)), PRESENT_TIMEOUT_MS);
        pending.set(requestId, { resolve, reject, timer });
        peer.write(`${JSON.stringify(command)}\n`);
      });
    },
    async close() {
      for (const requestId of [...pending.keys()]) settle(requestId, new Error("The bootstrap sideband closed"));
      peer?.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await rm(socketPath, { force: true });
    },
  };
}
