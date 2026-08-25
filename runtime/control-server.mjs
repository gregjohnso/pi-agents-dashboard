// @ts-nocheck
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmodPrivateSocket } from "./permissions.mjs";
import { createJsonlDecoder, createJsonlEncoder, JsonlFramingError } from "./jsonl.mjs";
import { parseClientRequest } from "../shared/contracts.js";

function dashboardError(code, message, retryable = false) { return { code, message, retryable }; }
function authError(value, token) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return dashboardError("INVALID_AUTH", "Authentication frame must be an object");
  if (value.version !== 1) return dashboardError("UNSUPPORTED_VERSION", "Protocol version must be 1");
  if (Object.keys(value).some((key) => key !== "version" && key !== "token")) return dashboardError("INVALID_AUTH", "Authentication frame contains unknown fields");
  if (typeof value.token !== "string") return dashboardError("AUTHENTICATION_FAILED", "Invalid control token");
  const supplied = Buffer.from(value.token); const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return dashboardError("AUTHENTICATION_FAILED", "Invalid control token");
}

/** Bind an authenticated, strict bounded-JSONL Unix-domain control server. */
export async function createControlServer({ socketPath, token, maxBytes, handleRequest, socketModeOps, uid }) {
  if (typeof token !== "string" || !token) throw new TypeError("token is required");
  if (typeof handleRequest !== "function") throw new TypeError("handleRequest is required");
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const decoder = createJsonlDecoder({ maxBytes }); const encoder = createJsonlEncoder({ maxBytes }); let authenticated = false; let chain = Promise.resolve();
    const send = (value) => { try { socket.write(encoder.encode(value)); return true; } catch { socket.end(); return false; } };
    const rejectConnection = (error) => { send({ version: 1, ok: false, error }); socket.end(); };
    socket.on("data", (chunk) => {
      let values;
      try { values = decoder.push(chunk); } catch (error) {
        const code = error instanceof JsonlFramingError ? error.code : "INVALID_FRAME";
        rejectConnection(dashboardError(code, error instanceof Error ? error.message : "Invalid frame")); return;
      }
      for (const value of values) chain = chain.then(async () => {
        if (!authenticated) {
          const error = authError(value, token); if (error) { rejectConnection(error); return; }
          authenticated = true; send({ version: 1, kind: "authenticated" }); return;
        }
        let request;
        try { request = parseClientRequest(value); } catch (error) {
          const requestId = typeof value === "object" && value !== null && typeof value.requestId === "string" ? value.requestId : "invalid-request";
          send({ version: 1, requestId, ok: false, error: dashboardError("INVALID_REQUEST", "Invalid client request") }); return;
        }
        try { send(await handleRequest(request, socket)); }
        catch (error) { send({ version: 1, requestId: request.requestId, ok: false, error: dashboardError("REQUEST_FAILED", error instanceof Error ? error.message : "Request failed", true) }); }
      }).catch(() => socket.destroy());
    });
    socket.on("end", () => { chain.finally(() => { try { decoder.end(); } catch (error) { send({ version: 1, ok: false, error: dashboardError(error.code ?? "INCOMPLETE_FRAME", error.message) }); } socket.end(); }); });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => { const onError = (error) => reject(error); server.once("error", onError); server.listen(socketPath, () => { server.off("error", onError); resolve(); }); });
  try { await chmodPrivateSocket(socketPath, socketModeOps, uid); }
  catch (error) { await new Promise((resolve) => server.close(resolve)); throw error; }
  return {
    socketPath,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
