import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const cryptoSpies = vi.hoisted(() => ({ timingSafeEqual: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = /** @type {typeof import("node:crypto")} */ (await importOriginal());
  return {
    ...actual,
    timingSafeEqual(/** @type {NodeJS.ArrayBufferView} */ left, /** @type {NodeJS.ArrayBufferView} */ right) {
      cryptoSpies.timingSafeEqual(left, right);
      return actual.timingSafeEqual(left, right);
    },
  };
});

import { createControlServer } from "./control-server.mjs";

/** @typedef {import("../shared/contracts.mjs").ClientRequest} ClientRequest */
/** @typedef {Parameters<typeof createControlServer>[0]} ControlServerOptions */

/** @type {Array<() => Promise<void>>} */
const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  cryptoSpies.timingSafeEqual.mockClear();
});

/** @param {Partial<ControlServerOptions>} [options] */
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "control-"));
  const socketPath = join(directory, "control.sock");
  /** @type {ClientRequest[]} */
  const received = [];
  const server = await createControlServer({
    socketPath,
    token: "secret",
    maxBytes: 256,
    handleRequest: async (request) => {
      received.push(request);
      return { version: 1, requestId: request.requestId, ok: true, result: { kind: "state", sessions: [] } };
    },
    ...options,
  });
  cleanups.push(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, received };
}

/** @param {string} socketPath @param {Array<string | Buffer>} chunks @returns {Promise<unknown[]>} */
function exchange(socketPath, chunks) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let text = "";
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("close", () => resolve(text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))));
    socket.on("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
      socket.end();
    });
  });
}

const auth = `${JSON.stringify({ version: 1, token: "secret" })}\n`;
const request = `${JSON.stringify({ version: 1, clientId: "client-1", requestId: "request-1", op: "get_state", payload: {} })}\n`;

describe("authenticated control server", () => {
  it("authenticates before accepting exact Task 4 requests", async () => {
    const { socketPath, received } = await fixture();
    const responses = await exchange(socketPath, [auth, request]);
    expect(responses[0]).toEqual({ version: 1, kind: "authenticated" });
    expect(responses[1]).toMatchObject({ requestId: "request-1", ok: true });
    expect(received).toHaveLength(1);
  });

  it("compares fixed-length authentication values even when token lengths differ", async () => {
    const { socketPath } = await fixture();
    await exchange(socketPath, [`${JSON.stringify({ version: 1, token: "x" })}\n`]);
    expect(cryptoSpies.timingSafeEqual).toHaveBeenCalledOnce();
    const [supplied, expected] = /** @type {[NodeJS.ArrayBufferView, NodeJS.ArrayBufferView]} */ (cryptoSpies.timingSafeEqual.mock.calls[0]);
    expect(supplied.byteLength).toBe(expected.byteLength);
  });

  it.each([
    ["wrong token", `${JSON.stringify({ version: 1, token: "wrong" })}\n`, "AUTHENTICATION_FAILED"],
    ["wrong auth version", `${JSON.stringify({ version: 2, token: "secret" })}\n`, "UNSUPPORTED_VERSION"],
    ["malformed JSON", "{oops\n", "MALFORMED_JSON"],
    ["oversized record", `${JSON.stringify({ version: 1, token: "x".repeat(300) })}\n`, "FRAME_TOO_LARGE"],
  ])("rejects %s without dispatch", async (_name, frame, code) => {
    const { socketPath, received } = await fixture();
    expect((await exchange(socketPath, [frame]))[0]).toMatchObject({ version: 1, ok: false, error: { code } });
    expect(received).toHaveLength(0);
  });

  it.each([
    ["unknown operation", { version: 1, clientId: "c", requestId: "exact-id", op: "shell", payload: {} }],
    ["wrong request version", { version: 2, clientId: "c", requestId: "exact-id", op: "get_state", payload: {} }],
  ])("rejects %s after authentication", async (_name, bad) => {
    const { socketPath, received } = await fixture();
    const responses = await exchange(socketPath, [auth, `${JSON.stringify(bad)}\n`]);
    expect(responses).toContainEqual(expect.objectContaining({ requestId: "exact-id", ok: false, error: expect.objectContaining({ code: "INVALID_REQUEST" }) }));
    expect(received).toHaveLength(0);
  });

  it("dispatches strict viewer snapshot, subscribe, and acknowledgement operations", async () => {
    const { socketPath, received } = await fixture();
    const viewerRequests = [
      { version: 1, clientId: "client-1", requestId: "viewer-1", op: "get_viewer_snapshot", payload: { sessionId: "session-1" } },
      { version: 1, clientId: "client-1", requestId: "viewer-2", op: "subscribe_viewer", payload: { sessionId: "session-1", after: { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: "0" } } },
      { version: 1, clientId: "client-1", requestId: "viewer-3", op: "ack_viewer", payload: { cursor: { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: "1" } } },
    ];
    const responses = await exchange(socketPath, [auth, ...viewerRequests.map((value) => `${JSON.stringify(value)}\n`)]);
    expect(responses.slice(1)).toHaveLength(3);
    expect(received).toEqual(viewerRequests);
  });

  it("does not dispatch worker action when a frontend disconnects", async () => {
    const { socketPath, received } = await fixture();
    await exchange(socketPath, [auth]);
    expect(received).toHaveLength(0);
  });
});
