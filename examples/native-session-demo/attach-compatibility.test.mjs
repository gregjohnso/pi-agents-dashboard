/**
 * The frontend's own precondition for entering a session, and what it does against an older manager.
 *
 * A manager that awaits the cold presentation before welcoming is not enough on its own: the operator's RUNNING
 * manager is older code, and a new frontend talking to it would have accepted its welcome and opened a session
 * that never repainted. The precondition therefore has to be checked at the CLIENT boundary too, which is what
 * `evaluateWelcome` is.
 *
 * Mixed-version rule under test:
 *   - new manager + new client  -> welcome carries a current-epoch cold-presentation confirmation, accepted.
 *   - OLD manager + new client  -> no confirmation field at all, refused by name as unsupported.
 *   - new manager + OLD client  -> the extra field is ignored, so nothing breaks (additive, nothing renamed).
 *
 * A refusal is a refusal. It does not repair the old session's lost sideband and is not claimed to.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ATTACH_PROTOCOL, evaluateWelcome } from "./client.mjs";
import { demoPaths } from "./demo-root.mjs";
import { encodeFrame } from "./protocol.mjs";
import { openPtyProcess, stopIdentifiedProcess } from "./smoke.mjs";

/**
 * How long the intentional refusal path is given to exit on its own.
 *
 * This case is deliberately RED-capable: if the refusal ever stops working the client would sit attached, so the
 * wait is bounded and teardown terminates the owned child through the real reap API rather than hoping it left.
 */
const REFUSAL_EXIT_MS = 30_000;

/** @type {(() => unknown)[]} */
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** A welcome exactly as the current manager sends it: old fields untouched, one additive confirmation. */
function currentWelcome(overrides = {}) {
  return {
    type: "welcome",
    attachmentId: "a1",
    epoch: 3,
    geometry: { cols: 181, rows: 79 },
    geometryRevision: 1,
    owner: { pid: 4242, startIdentity: "id-4242" },
    provider: "fixture/deterministic-echo",
    providerIsFake: true,
    ingressReady: true,
    coldPresentation: {
      attachProtocol: ATTACH_PROTOCOL,
      presented: true,
      attachmentId: "a1",
      epoch: 3,
      geometryRevision: 1,
      presentationNonce: "nonce-1",
    },
    ...overrides,
  };
}

describe("the frontend requires a current-epoch cold presentation before it accepts a welcome", () => {
  it("accepts a welcome whose confirmation is for this attachment and this epoch", () => {
    expect(evaluateWelcome(currentWelcome())).toMatchObject({ accepted: true });
  });

  it("refuses an OLD manager's welcome, which carries no confirmation at all", () => {
    const old = currentWelcome();
    delete old.coldPresentation;
    const verdict = evaluateWelcome(old);
    expect(verdict.accepted).toBe(false);
    expect(verdict.code).toBe("ATTACH_PRESENTATION_UNSUPPORTED");
    // Named and honest: it says what is missing and that the session was left alone.
    expect(verdict.message).toMatch(/older than this list|confirms no screen repaint/iu);
    expect(verdict.message).toMatch(/still running/iu);
  });

  it("refuses a confirmation that belongs to another epoch, so a stale one cannot be reused", () => {
    const verdict = evaluateWelcome(currentWelcome({
      coldPresentation: { attachProtocol: ATTACH_PROTOCOL, presented: true, attachmentId: "a1", epoch: 2, geometryRevision: 1, presentationNonce: "old" },
    }));
    expect(verdict.accepted).toBe(false);
    expect(verdict.code).toBe("ATTACH_PRESENTATION_UNCONFIRMED");
    expect(verdict.message).toMatch(/epoch/iu);
  });

  it("refuses a confirmation that belongs to another attachment", () => {
    const verdict = evaluateWelcome(currentWelcome({
      coldPresentation: { attachProtocol: ATTACH_PROTOCOL, presented: true, attachmentId: "somebody-else", epoch: 3, geometryRevision: 1, presentationNonce: "n" },
    }));
    expect(verdict).toMatchObject({ accepted: false, code: "ATTACH_PRESENTATION_UNCONFIRMED" });
  });

  it("refuses a peer that answered the presentation without presenting", () => {
    const verdict = evaluateWelcome(currentWelcome({
      coldPresentation: { attachProtocol: ATTACH_PROTOCOL, presented: false, attachmentId: "a1", epoch: 3, geometryRevision: 1, presentationNonce: null },
    }));
    expect(verdict).toMatchObject({ accepted: false, code: "ATTACH_PRESENTATION_UNCONFIRMED" });
  });

  it("refuses a confirmation from a protocol this frontend does not know", () => {
    const verdict = evaluateWelcome(currentWelcome({
      coldPresentation: { attachProtocol: ATTACH_PROTOCOL + 99, presented: true, attachmentId: "a1", epoch: 3, geometryRevision: 1, presentationNonce: "n" },
    }));
    expect(verdict).toMatchObject({ accepted: false, code: "ATTACH_PRESENTATION_UNSUPPORTED" });
  });

  it("reads only the additive field and renames none of the old ones", () => {
    // The fields an older frontend depends on are still exactly where they were.
    const welcome = currentWelcome();
    expect(evaluateWelcome(welcome)).toMatchObject({ accepted: true });
    for (const field of ["attachmentId", "epoch", "geometry", "geometryRevision", "owner", "provider", "ingressReady"]) {
      expect(Object.hasOwn(welcome, field)).toBe(true);
    }
  });
});

/**
 * The REAL client process, against a stand-in for an OLD manager.
 *
 * The stand-in speaks the wire protocol the operator's running manager speaks: it authenticates the client and
 * sends a welcome with no cold-presentation confirmation, and it never presents anything. Nothing about the real
 * manager is stubbed on the client's side of the socket - this is the actual `demo.mjs attach` binary.
 */
describe("the real client against an older manager", () => {
  async function legacyManager() {
    const base = join(tmpdir(), "x").length + 24 <= 100 || !existsSync("/tmp") ? tmpdir() : "/tmp";
    const root = await mkdtemp(path.join(base, "pia-legacy-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const paths = demoPaths(root);
    await mkdir(path.dirname(paths.token), { recursive: true }).catch(() => {});
    await writeFile(paths.token, "legacy-token-for-this-run-only\n");
    /** @type {any[]} */
    const seen = [];
    /** Every socket this fixture accepted, so teardown closes them instead of `server.close` waiting on them. */
    const accepted = new Set();
    const server = net.createServer((socket) => {
      accepted.add(socket);
      socket.on("close", () => accepted.delete(socket));
      socket.on("error", () => {});
      socket.on("data", () => {
        // One old-style welcome, exactly as a manager without the presentation precondition sends it.
        seen.push("hello");
        socket.write(encodeFrame({
          type: "welcome",
          attachmentId: "legacy-1",
          epoch: 1,
          geometry: { cols: 181, rows: 79 },
          geometryRevision: 1,
          owner: { pid: process.pid, startIdentity: "legacy" },
          provider: "legacy/unknown",
          ingressReady: true,
        }));
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.controlSocket, () => resolve(undefined));
    });
    cleanup.push(async () => {
      // The accepted sockets first: `server.close` only stops listening and waits for live connections.
      for (const socket of [...accepted]) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    });
    return { root, seen };
  }

  it("refuses it by name, on a real terminal, and never enters the session", async () => {
    const { root, seen } = await legacyManager();
    /** @type {any[]} */
    const spawned = [];
    const client = await openPtyProcess({
      args: [path.join(import.meta.dirname, "demo.mjs"), "attach", "--root", root, "--id", "legacy-1"],
      label: "legacy-attach",
      spawned,
      cols: 181,
      rows: 79,
    });
    // The real owned-process termination path, guarded exactly as the smoke harness guards it, so an
    // intentionally failing refusal cannot leave this child running or hang teardown on an optional no-op.
    cleanup.push(async () => {
      if (client.handle.reapIfExited() === null) {
        await stopIdentifiedProcess(client.handle.owner, "legacy-attach").catch(() => {});
      }
    });
    const exit = await Promise.race([
      client.handle.wait(),
      new Promise((resolve) => setTimeout(() => resolve(undefined), REFUSAL_EXIT_MS)),
    ]);
    const text = client.visible();
    if (exit === undefined) {
      throw new Error(`the refused attachment did not exit within ${REFUSAL_EXIT_MS}ms; visible was ${JSON.stringify(text.slice(-400))}`);
    }

    expect(seen).toContain("hello");
    // A named refusal the list can act on, and a non-zero exit so the transition reports an error.
    expect(text).toMatch(/ATTACH_PRESENTATION_UNSUPPORTED/u);
    expect(exit.code ?? exit.status).not.toBe(0);
    // It says the session was left alone, because a refusal repairs nothing.
    expect(text).toMatch(/still running/iu);
  });
});
