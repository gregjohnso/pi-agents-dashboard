import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmodPrivateSocket } from "./permissions.mjs";
import { createJsonlDecoder, createJsonlEncoder, JsonlFramingError } from "./jsonl.mjs";
import { parseClientRequest } from "../shared/contracts.js";

/** @typedef {import("../shared/contracts.js").ClientRequest} ClientRequest */
/** @typedef {import("../shared/contracts.js").DashboardError} DashboardError */

/** @param {string} code @param {string} message @param {boolean} [retryable] @returns {DashboardError} */
function dashboardError(code, message, retryable = false) {
  return { code, message, retryable };
}

/** @param {string} token @returns {Buffer} */
function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

/** @param {unknown} value @param {Buffer} expectedDigest @returns {DashboardError | undefined} */
function authError(value, expectedDigest) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return dashboardError("INVALID_AUTH", "Authentication frame must be an object");
  const auth = /** @type {Record<string, unknown>} */ (value);
  if (auth.version !== 1) return dashboardError("UNSUPPORTED_VERSION", "Protocol version must be 1");
  if (Object.keys(auth).some((key) => key !== "version" && key !== "token")) return dashboardError("INVALID_AUTH", "Authentication frame contains unknown fields");
  const supplied = typeof auth.token === "string" ? tokenDigest(auth.token) : tokenDigest("");
  const matches = timingSafeEqual(supplied, expectedDigest);
  if (typeof auth.token !== "string" || !matches) return dashboardError("AUTHENTICATION_FAILED", "Invalid control token");
}

/**
 * Bind an authenticated, strict bounded-JSONL Unix-domain control server.
 *
 * @param {{
 *   socketPath: string,
 *   token: string,
 *   maxBytes: number,
 *   handleRequest(request: ClientRequest, socket: net.Socket): Promise<unknown>,
 *   socketModeOps?: { lstat(path: string): Promise<any>, chmod(path: string, mode: number): Promise<void> },
 *   uid?: number,
 * }} options
 */
export async function createControlServer({ socketPath, token, maxBytes, handleRequest, socketModeOps, uid }) {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token is required");
  if (typeof handleRequest !== "function") throw new TypeError("handleRequest is required");
  const expectedDigest = tokenDigest(token);
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const decoder = createJsonlDecoder({ maxBytes });
    const encoder = createJsonlEncoder({ maxBytes });
    let authenticated = false;
    let chain = Promise.resolve();

    /** @param {unknown} value @returns {boolean} */
    const send = (value) => {
      try {
        socket.write(encoder.encode(value));
        return true;
      } catch {
        socket.end();
        return false;
      }
    };
    /** @param {DashboardError} error */
    const rejectConnection = (error) => {
      send({ version: 1, ok: false, error });
      socket.end();
    };

    socket.on("data", (chunk) => {
      let values;
      try {
        values = decoder.push(chunk);
      } catch (error) {
        const code = error instanceof JsonlFramingError ? error.code : "INVALID_FRAME";
        rejectConnection(dashboardError(code, error instanceof Error ? error.message : "Invalid frame"));
        return;
      }
      for (const value of values) {
        chain = chain.then(async () => {
          if (!authenticated) {
            const error = authError(value, expectedDigest);
            if (error !== undefined) {
              rejectConnection(error);
              return;
            }
            authenticated = true;
            send({ version: 1, kind: "authenticated" });
            return;
          }
          /** @type {ClientRequest} */
          let request;
          try {
            request = parseClientRequest(value);
          } catch {
            const requestId = typeof value === "object" && value !== null && typeof /** @type {{ requestId?: unknown }} */ (value).requestId === "string"
              ? /** @type {{ requestId: string }} */ (value).requestId
              : "invalid-request";
            send({ version: 1, requestId, ok: false, error: dashboardError("INVALID_REQUEST", "Invalid client request") });
            return;
          }
          try {
            send(await handleRequest(request, socket));
          } catch (error) {
            send({ version: 1, requestId: request.requestId, ok: false, error: dashboardError("REQUEST_FAILED", error instanceof Error ? error.message : "Request failed", true) });
          }
        }).catch(() => { socket.destroy(); });
      }
    });
    socket.on("end", () => {
      chain.finally(() => {
        try {
          decoder.end();
        } catch (error) {
          const framing = /** @type {{ code?: string, message?: string }} */ (error);
          send({ version: 1, ok: false, error: dashboardError(framing.code ?? "INCOMPLETE_FRAME", framing.message ?? "Incomplete frame") });
        }
        socket.end();
      }).catch(() => socket.destroy());
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve(undefined);
    });
  });
  try {
    await chmodPrivateSocket(socketPath, socketModeOps, uid);
  } catch (error) {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    throw error;
  }
  return {
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
    },
  };
}
