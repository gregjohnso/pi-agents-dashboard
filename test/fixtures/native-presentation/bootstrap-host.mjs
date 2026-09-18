/**
 * The host side of seam E's core bootstrap sideband, and the pseudo-terminal a real client attaches to.
 *
 * A host creates the unix-domain listener first, then launches Pi with `PI_NATIVE_BOOTSTRAP_SOCKET` set.
 * Pi connects out during `main()`, before any extension module is loaded, so the readiness frames arrive
 * whatever an extension's `session_start` handler later does. Nothing here polls: every wait resolves from
 * a socket frame or a terminal read, with a bound that fails the case rather than hanging it.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

/**
 * One host listener. `waitFor` resolves from the frame stream, never from a poll loop.
 *
 * The listener owns its socket path and puts it in a short directory of its own. Measured on worker 3739922:
 * in one process on one filesystem, binding a 179-byte path succeeded while a 184-byte path failed with
 * `EADDRINUSE` on a path that did not exist, and a 39-byte path under the machine's `/tmp` succeeded. A
 * socket is a transport, not an output, so it is created here and removed by `close`.
 */
export async function startBootstrapHost() {
  const directory = await mkdtemp("/tmp/pi-seam-e-host-");
  const socketPath = path.join(directory, "s");
  const frames = [];
  const waiters = [];
  let peer;
  let buffered = "";

  const deliver = (frame) => {
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  };

  // `allowHalfOpen` keeps this peer writable after Pi half-closes its own side, which is what makes a write
  // after a refused frame observable at all: Pi answers the breach, sends FIN, and a case still sends one
  // more command to prove nothing reads it. A default server would auto-end and the command would never leave.
  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    peer = connection;
    connection.setEncoding("utf8");
    connection.on("error", () => {});
    connection.on("data", (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) deliver(JSON.parse(line));
        newline = buffered.indexOf("\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    frames,
    /** The phases the host has learned so far, in arrival order. */
    phases() {
      const reached = [];
      for (const frame of frames) {
        if (frame.type === "native-bootstrap") reached.push(...frame.reached.map((entry) => entry.phase));
        if (frame.type === "native-readiness") reached.push(frame.readiness.phase);
      }
      return reached;
    },
    readiness(phase) {
      for (const frame of frames) {
        if (frame.type === "native-bootstrap") {
          const found = frame.reached.find((entry) => entry.phase === phase);
          if (found) return found;
        }
        if (frame.type === "native-readiness" && frame.readiness.phase === phase) return frame.readiness;
      }
      return undefined;
    },
    waitFor(predicate, label, timeoutMs = 60_000) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`no ${label} frame arrived within ${timeoutMs}ms; frames so far: ${JSON.stringify(frames)}`));
        }, timeoutMs);
        waiter.resolve = (frame) => {
          clearTimeout(timer);
          resolve(frame);
        };
      });
    },
    /** Resolves with the readiness record for `phase`, whether it arrived in the hello or as an event. */
    async waitForPhase(phase, timeoutMs) {
      await this.waitFor(
        (frame) =>
          (frame.type === "native-readiness" && frame.readiness.phase === phase) ||
          (frame.type === "native-bootstrap" && frame.reached.some((entry) => entry.phase === phase)),
        `readiness ${phase}`,
        timeoutMs,
      );
      return this.readiness(phase);
    },
    send(command) {
      if (!peer) throw new Error("Pi has not connected to the bootstrap sideband yet");
      peer.write(`${JSON.stringify(command)}\n`);
    },
    /** Bytes exactly as given: a frame bound is not reachable through `send`, which always frames one line. */
    sendRaw(bytes) {
      if (!peer) throw new Error("Pi has not connected to the bootstrap sideband yet");
      peer.write(bytes);
    },
    async close() {
      peer?.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Pi under a real pseudo-terminal, through `script`, which is what makes the client a terminal rather than
 * a pipe: the alt screen, mouse modes and the Kitty keyboard negotiation all need one.
 */
export function spawnPiUnderPty({ command, cwd, env, transcriptPath }) {
  const child = spawn("script", ["-qfec", command, transcriptPath], {
    cwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const waiters = [];
  const predicateWaiters = [];
  const onChunk = (chunk) => {
    output += chunk.toString("utf8");
    for (const waiter of [...waiters]) {
      if (output.includes(waiter.needle)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(output.length);
      }
    }
    for (const waiter of [...predicateWaiters]) {
      if (waiter.predicate(output)) {
        predicateWaiters.splice(predicateWaiters.indexOf(waiter), 1);
        waiter.resolve(output.length);
      }
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.stdin.on("error", () => {});

  return {
    child,
    output: () => output,
    since: (index) => output.slice(index),
    length: () => output.length,
    write(data) {
      if (child.stdin.writable) child.stdin.write(data);
    },
    /** Resolves when `predicate(output)` holds, re-evaluated on each terminal read. */
    waitUntil(predicate, label, timeoutMs = 60_000) {
      if (predicate(output)) return Promise.resolve(output.length);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        predicateWaiters.push(waiter);
        const timer = setTimeout(() => {
          const index = predicateWaiters.indexOf(waiter);
          if (index !== -1) predicateWaiters.splice(index, 1);
          reject(new Error(`the terminal never reached ${label} within ${timeoutMs}ms`));
        }, timeoutMs);
        waiter.resolve = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
    },
    waitForText(needle, timeoutMs = 60_000) {
      if (output.includes(needle)) return Promise.resolve(output.length);
      return new Promise((resolve, reject) => {
        const waiter = { needle, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`the terminal never showed ${JSON.stringify(needle)} within ${timeoutMs}ms`));
        }, timeoutMs);
        waiter.resolve = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
    },
    exited() {
      return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    },
  };
}
