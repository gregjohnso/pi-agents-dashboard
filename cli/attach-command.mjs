import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describeAuthenticationRefusal, exactId, loadCliClientIdentity, resolveRuntimeRoot } from "./session-commands.mjs";

const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * Open one authenticated viewer connection for a single session.
 * The dashboard's own list holds this state across sessions; one attachment lives and dies with
 * this process, so an unsubmitted draft is not written anywhere.
 * @param {{root: string, clientId: string, sessionId: string}} options
 */
async function defaultConnect({ root, clientId, sessionId }) {
  const { createDaemonClient } = await import(new URL("../app/daemon-client.mjs", import.meta.url).href);
  const { createStandaloneViewer } = await import(new URL("../app/standalone.mjs", import.meta.url).href);
  const token = (await readFile(join(root, "daemon", "control.token"), "utf8")).trim();
  const client = createDaemonClient({ socketPath: join(root, "daemon", "control.sock"), token, maxBytes: MAX_FRAME_BYTES, clientId, attachId: randomUUID() });
  await client.connect();
  const viewerClient = client;
  /** @type {any} */
  let viewerState;
  return {
    viewerClient,
    createViewer() {
      /** @type {any} */
      let viewer;
      viewer = createStandaloneViewer({
        sessionId, client: viewerClient,
        persistence: { async load() { return viewerState; }, async save(/** @type {any} */ value) { viewerState = structuredClone(value); } },
        onReturn: () => { void viewer.close(); },
      });
      return viewer;
    },
    close: () => client.close(),
  };
}

/** Open the viewer for one exact session and release it when the operator returns. */
export async function attachSession(sessionId, options = {}) {
  if (!exactId(sessionId)) return { code: 2, error: { code: "INVALID_SYNTAX", message: "Usage: pi-agents attach <full-session-id>" } };
  const root = options.root ?? resolveRuntimeRoot(options.env);
  const clientId = await loadCliClientIdentity({ root, randomId: options.randomId });
  /** @type {any} */
  let connection;
  try {
    connection = await (options.connect ?? defaultConnect)({ root, clientId, sessionId });
  } catch (error) {
    const described = await describeAuthenticationRefusal(root, error);
    return { code: 1, error: { code: described?.code ?? "ATTACH_FAILED", message: described instanceof Error ? described.message : "Attach failed" } };
  }
  /** @type {any} */
  let viewer;
  let attached = false;
  try {
    await connection.viewerClient.attach(sessionId);
    attached = true;
    viewer = connection.createViewer();
    await viewer.open();
    await viewer.closed;
  } catch (error) {
    return { code: 1, error: { code: error?.code ?? "ATTACH_FAILED", message: error instanceof Error ? error.message : "Attach failed" } };
  } finally {
    await viewer?.close().catch(() => {});
    if (attached) await connection.viewerClient.detach(sessionId).catch(() => {});
    await connection.close();
  }
  return { code: 0, result: { kind: "detached", sessionId } };
}
