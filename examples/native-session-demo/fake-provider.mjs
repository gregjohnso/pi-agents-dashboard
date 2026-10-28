/**
 * A fake provider. It answers from a hash of the prompt and never opens a socket.
 *
 * **This is a demonstration fixture, not a model.** It exists so the demo can show a complete turn —
 * operator draft, native submission, assistant reply rendered by Pi's own transcript — without a credential
 * and without inference. It is labelled in the model name, in the reply text and on the demo's widget line,
 * so an operator watching the terminal cannot mistake it for a real answer.
 *
 * The reply is a pure function of the conversation, so the same draft produces the same bytes on every run.
 * That is what makes the smoke assertable: the expected text is computed here, not scraped from a screen.
 *
 * Nothing in this file imports Pi. `createFakeStreamSimple` takes Pi's own event-stream factory as an
 * argument, so the pure part is testable outside a Pi process and the stream Pi consumes is always the one
 * Pi's own bundle built.
 */

import { createHash } from "node:crypto";

export const FAKE_PROVIDER_ID = "native-session-demo-fake";
export const FAKE_MODEL_ID = "deterministic-echo";
/**
 * A second labelled fixture model, so model selection is observable without a real provider.
 *
 * Both answer with the same deterministic reply: the point is two distinct identities the picker can offer and
 * the owner can be told to use, not two behaviours.
 */
export const FAKE_MODEL_ID_ALT = "deterministic-echo-alt";
export const FAKE_LABEL_MODEL_ID = "deterministic-haiku-labels";
export const FAKE_MODEL_NAME = "Deterministic Echo (demo fake, no model is called)";
export const FAKE_REPLY_PREFIX = "DEMO-FAKE-REPLY";

/** @param {string | (any[])} content */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * The reply for one conversation: a prefix an assertion can anchor on, a digest of the whole prompt, and a
 * single-line echo of the last operator message so a human can see their own words came back through Pi.
 *
 * @param {{ messages?: any[] }} context
 */
export function deterministicReply(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const prompt = textOf(lastUser?.content ?? "");
  const digest = createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 12);
  const echo = prompt.replace(/\s+/gu, " ").trim().slice(0, 120);
  return `${FAKE_REPLY_PREFIX} ${digest} :: ${echo}`;
}

/** The model entries Pi registers for the fake provider. Zero cost, because nothing is spent. */
export function fakeModelConfigs() {
  return [fakeModelConfig(), { ...fakeModelConfig(), id: FAKE_MODEL_ID_ALT, name: `${FAKE_MODEL_NAME} (alt)` },
    { ...fakeModelConfig(), id: FAKE_LABEL_MODEL_ID, name: "Deterministic labels (demo fake, no model is called)" }];
}

/** The model entry Pi registers for the fake provider. Zero cost, because nothing is spent. */
export function fakeModelConfig() {
  return {
    id: FAKE_MODEL_ID,
    name: FAKE_MODEL_NAME,
    reasoning: false,
    input: /** @type {("text" | "image")[]} */ (["text"]),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

/**
 * Build the `streamSimple` Pi calls, using Pi's own event-stream factory.
 *
 * The event order is upstream's documented one — `start`, one text block, `done` — and the terminal event
 * carries the same message object the deltas built, so Pi's transcript and its session file record exactly
 * what was streamed. An abort before the reply is emitted ends the stream as `aborted` rather than
 * pretending a reply arrived.
 *
 * @param {{ createStream: () => any }} deps
 */
export function createFakeStreamSimple({ createStream }) {
  return function streamFakeProvider(/** @type {any} */ model, /** @type {any} */ context, /** @type {any} */ options) {
    const stream = createStream();
    const reply = model.id === FAKE_LABEL_MODEL_ID
      ? "Title: Demo fake task\nSummary: Exercises native session labels with a deterministic fake provider"
      : deterministicReply(context);
    const output = {
      role: "assistant",
      content: /** @type {any[]} */ ([]),
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: /** @type {string} */ ("pending"),
      timestamp: Date.now(),
    };

    stream.push({ type: "start", partial: output });
    if (options?.signal?.aborted) {
      output.stopReason = "aborted";
      output.errorMessage = "The demo fake provider was aborted before it answered";
      stream.push({ type: "error", reason: "aborted", error: output });
      stream.end();
      return stream;
    }
    output.content.push({ type: "text", text: "" });
    const contentIndex = output.content.length - 1;
    stream.push({ type: "text_start", contentIndex, partial: output });
    /**
     * Finish the answer. Split out so a fixture can hold the turn open.
     *
     * `PI_DEMO_FAKE_DELAY_MS` exists for one reason: a reply that lands in under a millisecond means a test can
     * never catch the session in its WORKING state, and a test that cannot see WORKING must not claim it did.
     * It slows the FIXTURE, never the demo: unset, this is the same immediate answer as before.
     */
    const finish = () => {
      output.content[contentIndex].text = reply;
      stream.push({ type: "text_delta", contentIndex, delta: reply, partial: output });
      stream.push({ type: "text_end", contentIndex, content: reply, partial: output });
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    };
    const holdMs = Number(process.env.PI_DEMO_FAKE_DELAY_MS ?? "0");
    if (Number.isFinite(holdMs) && holdMs > 0) setTimeout(finish, Math.min(holdMs, 60_000));
    else finish();
    return stream;
  };
}
