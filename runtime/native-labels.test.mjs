import { expect, it } from "vitest";
import { generateNativeLabel, nativeLabelsFromFacts } from "./native-labels.mjs";

const MODEL = { provider: "fixture", id: "haiku", cost: { output: 1 } };
const REPLY = { stopReason: "stop", content: [{ type: "text", text: "  Title: Informative task  \n\n  Summary: Describes the work clearly  \n" }] };

/** @param {any} response */
function generate(response) {
  return generateNativeLabel({ getAvailable: () => [MODEL], complete: async () => response }, "private conversation", { signal: new AbortController().signal });
}

it("accepts blank lines and surrounding whitespace without accepting arbitrary prose", async () => {
  expect(await generate(REPLY)).toMatchObject({ status: "ready", name: "Informative task", description: "Describes the work clearly" });
  expect(await generate({ ...REPLY, content: [{ type: "text", text: "Extra prose\nTitle: Task\nSummary: Work" }] })).toMatchObject({ status: "malformed", failureReason: "format" });
});

it.each(["length", "error", "aborted"])("records %s without persisting private response or provider error text", async (stopReason) => {
  const result = await generate({ ...REPLY, stopReason, errorMessage: "secret credential", content: [{ type: "text", text: "private response" }] });
  expect(result).toMatchObject({ status: stopReason === "error" ? "error" : "malformed", stopReason, failureReason: "stop-reason", modelProvider: "fixture", modelId: "haiku" });
  expect(JSON.stringify(result)).not.toMatch(/private|secret/);
});

it("prefers explicitly configured Haiku credentials over incidental cluster AWS environment", async () => {
  let selected;
  await generateNativeLabel({
    getAvailable: () => [{ ...MODEL, provider: "amazon-bedrock", cost: { output: 0.1 } }, MODEL],
    getProviderAuthStatus: (/** @type {string} */ provider) => ({ source: provider === "fixture" ? "stored" : "environment" }),
    complete: async (/** @type {any} */ model) => { selected = model; return REPLY; },
  }, "task", { signal: new AbortController().signal });
  expect(selected).toBe(MODEL);
});

it("keeps safe failure diagnostics in saved labels and ignores unsupported versions", () => {
  const facts = { sessionId: "s1", labelVersion: 1, labelStatus: "malformed", labelModelProvider: "fixture", labelModelId: "haiku", labelFailureReason: "stop-reason", labelStopReason: "length" };
  expect(nativeLabelsFromFacts(facts)).toMatchObject({ status: "malformed", failureReason: "stop-reason", stopReason: "length" });
  expect(nativeLabelsFromFacts({ ...facts, labelVersion: 99 })).toBeUndefined();
});

it("prefers the ChatGPT subscription's small model over Haiku, with low reasoning and room to answer", async () => {
  const luna = { provider: "openai-codex", id: "gpt-6-luna", cost: { output: 0.5 } };
  /** @type {any[]} */
  const calls = [];
  await generateNativeLabel({
    getAvailable: () => [{ ...MODEL, cost: { output: 0.1 } }, { provider: "openai-codex", id: "gpt-6.1-sol", cost: { output: 30 } }, luna],
    getProviderAuthStatus: () => ({ source: "stored" }),
    complete: async (/** @type {any} */ model, /** @type {any} */ _context, /** @type {any} */ options) => { calls.push({ model, options }); return REPLY; },
  }, "task", { signal: new AbortController().signal });
  expect(calls[0].model).toBe(luna);
  expect(calls[0].options).toMatchObject({ reasoning: "low", maxTokens: 2048 });
});

it("falls back to Haiku when no ChatGPT small model is available", async () => {
  let selected;
  await generateNativeLabel({
    getAvailable: () => [{ provider: "openai-codex", id: "gpt-6.1-sol", cost: { output: 30 } }, MODEL],
    complete: async (/** @type {any} */ model) => { selected = model; return REPLY; },
  }, "task", { signal: new AbortController().signal });
  expect(selected).toBe(MODEL);
});
