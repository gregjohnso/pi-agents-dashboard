/**
 * The one wire format the demo manager, its clients and its in-Pi ingress caller share.
 *
 * One frame is a bounded JSON header plus an optional raw body, so a keystroke and a block of terminal
 * output travel the same way and neither is re-encoded: the body is the operator's bytes exactly as the
 * frontend read them, and the header says whose they are. There is no schema registry, no request/response
 * correlation and no versioned negotiation beyond `PROTOCOL`: a peer that speaks another number is refused.
 *
 * Bounds are the point. A reader that grew with its peer's input would be a denial of service on the
 * manager that holds the owner, so a frame above `MAX_FRAME_BYTES` or a header above `MAX_HEADER_BYTES`
 * ends that connection instead of being buffered.
 */

export const PROTOCOL = 1;
/** One frame, header and body together. Terminal output is chunked to `MAX_BODY_BYTES` before framing. */
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_BODY_BYTES = MAX_FRAME_BYTES - MAX_HEADER_BYTES - 6;

const LENGTH_BYTES = 4;
const HEADER_LENGTH_BYTES = 2;

/** A refused frame, a refused peer, or a bound a peer crossed. Never a warning. */
export class DemoProtocolError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = "DemoProtocolError";
    this.code = code;
  }
}

/**
 * @param {Record<string, unknown>} header
 * @param {Uint8Array} [body]
 * @returns {Buffer}
 */
export function encodeFrame(header, body = new Uint8Array(0)) {
  const headerBytes = Buffer.from(JSON.stringify({ protocol: PROTOCOL, ...header }), "utf8");
  if (headerBytes.byteLength > MAX_HEADER_BYTES) {
    throw new DemoProtocolError(`A frame header of ${headerBytes.byteLength} bytes is above the ${MAX_HEADER_BYTES} byte bound`, "DEMO_HEADER_TOO_LARGE");
  }
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new DemoProtocolError(`A frame body of ${body.byteLength} bytes is above the ${MAX_BODY_BYTES} byte bound`, "DEMO_BODY_TOO_LARGE");
  }
  const payloadLength = HEADER_LENGTH_BYTES + headerBytes.byteLength + body.byteLength;
  const frame = Buffer.allocUnsafe(LENGTH_BYTES + payloadLength);
  frame.writeUInt32BE(payloadLength, 0);
  frame.writeUInt16BE(headerBytes.byteLength, LENGTH_BYTES);
  headerBytes.copy(frame, LENGTH_BYTES + HEADER_LENGTH_BYTES);
  Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(frame, LENGTH_BYTES + HEADER_LENGTH_BYTES + headerBytes.byteLength);
  return frame;
}

/**
 * A bounded incremental reader. `onFrame` receives `{ header, body }`; `onRefusal` receives the one
 * `DemoProtocolError` that ends this stream, after which nothing more is parsed.
 *
 * @param {(frame: { header: any, body: Buffer }) => void} onFrame
 * @param {(error: DemoProtocolError) => void} onRefusal
 */
export function createFrameReader(onFrame, onRefusal) {
  /** @type {Buffer[]} */
  let chunks = [];
  let buffered = 0;
  let refused = false;

  const refuse = (message, code) => {
    refused = true;
    chunks = [];
    buffered = 0;
    onRefusal(new DemoProtocolError(message, code));
  };

  return {
    /** @param {Buffer} chunk */
    push(chunk) {
      if (refused) return;
      chunks.push(chunk);
      buffered += chunk.byteLength;
      if (buffered > MAX_FRAME_BYTES + LENGTH_BYTES) {
        refuse(`A peer buffered ${buffered} bytes without completing a frame, above the ${MAX_FRAME_BYTES} byte bound`, "DEMO_FRAME_TOO_LARGE");
        return;
      }
      let pending = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
      for (;;) {
        if (pending.byteLength < LENGTH_BYTES) break;
        const payloadLength = pending.readUInt32BE(0);
        if (payloadLength > MAX_FRAME_BYTES || payloadLength < HEADER_LENGTH_BYTES) {
          refuse(`A frame declared ${payloadLength} payload bytes, outside 2..${MAX_FRAME_BYTES}`, "DEMO_FRAME_TOO_LARGE");
          return;
        }
        if (pending.byteLength < LENGTH_BYTES + payloadLength) break;
        const headerLength = pending.readUInt16BE(LENGTH_BYTES);
        if (headerLength > MAX_HEADER_BYTES || HEADER_LENGTH_BYTES + headerLength > payloadLength) {
          refuse(`A frame declared ${headerLength} header bytes inside a ${payloadLength} byte payload`, "DEMO_HEADER_TOO_LARGE");
          return;
        }
        const headerStart = LENGTH_BYTES + HEADER_LENGTH_BYTES;
        let header;
        try {
          header = JSON.parse(pending.toString("utf8", headerStart, headerStart + headerLength));
        } catch (cause) {
          refuse(`A frame header was not JSON: ${/** @type {Error} */ (cause).message}`, "DEMO_HEADER_UNPARSEABLE");
          return;
        }
        if (header === null || typeof header !== "object" || Array.isArray(header) || header.protocol !== PROTOCOL) {
          refuse(`A frame header must be an object carrying protocol ${PROTOCOL}`, "DEMO_PROTOCOL_MISMATCH");
          return;
        }
        const body = pending.subarray(headerStart + headerLength, LENGTH_BYTES + payloadLength);
        pending = pending.subarray(LENGTH_BYTES + payloadLength);
        onFrame({ header, body });
        if (refused) return;
      }
      chunks = pending.byteLength === 0 ? [] : [pending];
      buffered = pending.byteLength;
    },
  };
}
