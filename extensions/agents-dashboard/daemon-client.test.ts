import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonlDecoder, encodeJsonl } from "../../runtime/jsonl.mjs";
import { createDaemonClient } from "./daemon-client.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
async function serverFixture(dropFirst = false) {
  const directory = await mkdtemp(join(tmpdir(), "client-")); const socketPath = join(directory, "control.sock"); let requests = 0;
  const server = net.createServer((socket) => { const decoder = createJsonlDecoder({ maxBytes: 1024 }); let authed = false; socket.on("data", (chunk) => { for (const value of decoder.push(chunk)) { if (!authed) { authed = true; socket.write(encodeJsonl({ version: 1, kind: "authenticated" })); continue; } requests += 1; const request = value as { requestId: string }; if (dropFirst && requests === 1) { socket.destroy(); continue; } socket.write(encodeJsonl({ version: 1, requestId: request.requestId, ok: true, result: { kind: "state", sessions: [] } })); } }); });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  return { socketPath, count: () => requests };
}
const request = { version: 1 as const, clientId: "client-1", requestId: "exact-request-id", op: "get_state" as const, payload: {} };

describe("daemon client", () => {
  it("authenticates and correlates responses by exact request ID", async () => {
    const fixture = await serverFixture(); const client = createDaemonClient({ socketPath: fixture.socketPath, token: "secret", maxBytes: 1024 }); cleanups.push(() => client.close());
    await client.connect();
    expect(await client.request(request)).toMatchObject({ requestId: "exact-request-id", ok: true });
  });

  it("reconnects and resends the same request after disconnect without worker-side cancellation", async () => {
    const fixture = await serverFixture(true); const client = createDaemonClient({ socketPath: fixture.socketPath, token: "secret", maxBytes: 1024, reconnectDelayMs: 1 }); cleanups.push(() => client.close());
    expect(await client.request(request)).toMatchObject({ requestId: "exact-request-id", ok: true });
    expect(fixture.count()).toBe(2);
  });

  it("rejects changed payload reuse locally", async () => {
    const fixture = await serverFixture(); const client = createDaemonClient({ socketPath: fixture.socketPath, token: "secret", maxBytes: 1024 }); cleanups.push(() => client.close());
    await client.request(request);
    await expect(client.request({ ...request, payload: { changed: true } } as never)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
