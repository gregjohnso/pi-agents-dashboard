import { DIALOG_UI_METHODS } from "./viewer-normalizer.mjs";

/**
 * Recent Pi frames one worker keeps in memory, in bytes of serialized frame.
 *
 * Claude Code's pseudo-terminal host retains exactly 262,144 bytes of recent output and replays it to
 * every attaching client (docs/reference/claude-code-behavior.md). This is the same budget for the
 * same reason: it is what a daemon needs to rebuild a mid-turn transcript, and it is small enough
 * that a session running for days costs the worker nothing that grows.
 */
export const MAX_LIVE_TAIL_BYTES = 262_144;
/**
 * One retained frame's own bound. A frame larger than this is forwarded live and then forgotten,
 * because retaining it would spend the whole tail on a single Pi payload.
 */
export const MAX_LIVE_TAIL_FRAME_BYTES = 65_536;

/**
 * Keep the newest Pi frames this worker produced, for replay to a daemon that has none of them.
 *
 * The oldest frames leave first when the bound is reached, except an unresolved Pi dialog request:
 * Pi is blocked on a person until that request is answered, and a frontend that attaches later can
 * only learn about it from here. It is retained until Pi resolves it, or until it is the only thing
 * left and the byte bound takes it too. Every frame the tail lets go is counted, so a daemon that
 * rebuilds from a short tail can say so.
 *
 * @param {{ maxBytes?: number, maxFrameBytes?: number }} [options]
 */
export function createLiveTail({ maxBytes = MAX_LIVE_TAIL_BYTES, maxFrameBytes = MAX_LIVE_TAIL_FRAME_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new TypeError("maxFrameBytes must be a positive safe integer");
  /** @type {{ frame: any, bytes: number, uiRequestId: string | undefined }[]} */
  const entries = [];
  let bytes = 0;
  let dropped = 0;

  function evict() {
    while (bytes > maxBytes && entries.length > 0) {
      const unpinned = entries.findIndex((entry) => entry.uiRequestId === undefined);
      const [victim] = entries.splice(unpinned >= 0 ? unpinned : 0, 1);
      bytes -= victim.bytes;
      dropped += 1;
    }
  }

  return {
    /** @param {any} frame */
    record(frame) {
      let encoded;
      try {
        encoded = Buffer.byteLength(JSON.stringify(frame) ?? "null");
      } catch {
        dropped += 1;
        return;
      }
      if (encoded > maxFrameBytes) {
        dropped += 1;
        return;
      }
      if (frame?.type === "extension_ui_resolved" && typeof frame.id === "string") {
        for (const entry of entries) if (entry.uiRequestId === frame.id) entry.uiRequestId = undefined;
      }
      const pinned = frame?.type === "extension_ui_request" && DIALOG_UI_METHODS.has(frame.method) && typeof frame.id === "string";
      entries.push({ frame, bytes: encoded, uiRequestId: pinned ? frame.id : undefined });
      bytes += encoded;
      evict();
    },
    /** The retained frames in the order Pi produced them. */
    frames() { return entries.map((entry) => entry.frame); },
    /** How many frames this tail let go, which is what a rebuilt transcript may be missing. */
    get dropped() { return dropped; },
    get bytes() { return bytes; },
  };
}
