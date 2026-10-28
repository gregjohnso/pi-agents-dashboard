/**
 * A disposable stand-in for an OLDER manager, used to exercise the refusal path through the real dashboard.
 *
 * It speaks exactly the wire the operator's running manager speaks: it authenticates a client and sends a
 * `welcome` with NO cold-presentation confirmation, and it never presents anything. That is the whole point - it
 * is the mixed-version peer, so the list's refusal can be seen end to end without touching any real session and
 * without needing a real Pi to misbehave.
 *
 * It owns nothing but its own socket and its own directory. There is no owner process, so nothing can be killed,
 * signalled or left behind; `status` reports a live-looking record so the row appears in the list.
 */

import net from "node:net";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { demoPaths } from "./demo-root.mjs";
import { createFrameReader, encodeFrame } from "./protocol.mjs";

const TOKEN = "legacy-manager-fixture-token\n";

/**
 * @param {string} root
 * @returns {Promise<{ root: string, close: () => Promise<void>, welcomes: () => number }>}
 */
export async function startLegacyManagerFixture(root) {
  await mkdir(root, { recursive: true });
  const paths = demoPaths(root);
  await writeFile(paths.token, TOKEN);
  let welcomes = 0;
  /** Every accepted socket, so closing this fixture does not wait on a live connection. */
  const accepted = new Set();
  const startedAtMs = Date.now();

  const server = net.createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => {});
    let role = null;
    const reader = createFrameReader(
      ({ header }) => {
        if (role === null) {
          role = header?.role ?? null;
          if (role === "client") {
            welcomes += 1;
            // The old shape: every field an older manager sent, and nothing that confirms a repaint.
            socket.write(encodeFrame({
              type: "welcome",
              attachmentId: typeof header.attachmentId === "string" ? header.attachmentId : "legacy-1",
              epoch: 1,
              geometry: { cols: header.cols ?? 80, rows: header.rows ?? 24 },
              geometryRevision: 1,
              owner: { pid: process.pid, startIdentity: "legacy-fixture" },
              provider: "legacy-fixture/none",
              ingressReady: true,
            }));
          }
          return;
        }
        if (role === "control" && header?.type === "status") {
          socket.write(encodeFrame({
            type: "status",
            status: {
              root,
              owner: { pid: process.pid, startIdentity: "legacy-fixture", launchedAtMs: startedAtMs },
              geometry: { cols: 181, rows: 79 },
              geometryRevision: 1,
              attachments: [],
              exit: null,
              reaped: null,
              projectCwd: root,
              readiness: [{ phase: "native-mounted" }],
              presentations: [],
              // A faithful stand-in for the operator's own old session: its owner bridge works and publishes
              // facts, so the row legitimately reads READY. What it does NOT have is an `attach` advertisement,
              // because that field postdates it. That combination - a live, ready agent this list cannot open -
              // is exactly the case the label exists for.
              bridge: { connected: true, facts: { agentPhase: "settled", idle: true, pendingMessages: false } },
            },
          }));
        }
      },
      () => socket.destroy(),
    );
    socket.on("data", (chunk) => reader.push(chunk));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.controlSocket, () => resolve(undefined));
  });

  return {
    root,
    welcomes: () => welcomes,
    async close() {
      for (const socket of [...accepted]) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const root = process.argv[2];
  if (root === undefined) throw new Error("usage: legacy-manager-fixture.mjs <root>");
  const fixture = await startLegacyManagerFixture(root);
  process.stdout.write(`legacy manager fixture listening for ${fixture.root}\n`);
  for (const signal of /** @type {NodeJS.Signals[]} */ (["SIGTERM", "SIGINT", "SIGHUP"])) {
    process.on(signal, () => {
      void fixture.close().then(() => process.exit(0));
    });
  }
}
