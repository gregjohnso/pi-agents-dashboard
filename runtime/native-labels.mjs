import { parseSummaryReply, summaryPrompt } from "./summaries.mjs";

const LABEL_STATUSES = ["pending", "ready", "unavailable-model", "unavailable-auth", "error", "malformed", "timeout"];
const CONTROL_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const LABEL_TIMEOUT_MS = 10_000;
const FAILURE_REASONS = ["stop-reason", "format", "oversized", "empty-label", "request-failed", "timeout", "rename-failed"];
const STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted", "unknown"];

/** @param {unknown} value @param {number} max */
function displayText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL_TEXT.test(value) ? value.trim() : undefined;
}

/**
 * Optional labels version 1 is additive to sideband protocol 1 and owner record 2. Older readers ignore these
 * fields; absent labels remain unknown, and unsupported versions are ignored without refusing the owner.
 * @param {any} value @param {unknown} sessionId
 */
export function readNativeLabels(value, sessionId) {
  if (value?.version !== 1 || typeof sessionId !== "string" || value.sessionId !== sessionId || !LABEL_STATUSES.includes(value.status)) return undefined;
  return {
    version: 1, sessionId, status: value.status,
    description: displayText(value.description, 240),
    modelProvider: displayText(value.modelProvider, 200),
    modelId: displayText(value.modelId, 200),
    failureReason: FAILURE_REASONS.includes(value.failureReason) ? value.failureReason : undefined,
    stopReason: STOP_REASONS.includes(value.stopReason) ? value.stopReason : undefined,
  };
}

/** Preserve a description across same-session reload only, never across a replacement or unknown schema.
 * @param {any} facts @param {any} [previous]
 */
export function nativeLabelsFromFacts(facts, previous) {
  const prior = readNativeLabels(previous, facts?.sessionId);
  if (facts?.labelVersion === undefined) return prior;
  const current = readNativeLabels({ version: facts.labelVersion, sessionId: facts.sessionId, status: facts.labelStatus,
    description: facts.labelDescription, modelProvider: facts.labelModelProvider, modelId: facts.labelModelId,
    failureReason: facts.labelFailureReason, stopReason: facts.labelStopReason }, facts.sessionId);
  return current === undefined ? undefined : { ...current, description: current.description ?? prior?.description };
}

/** One tool-free, unpersisted completion through this Pi's existing registry/auth/config. No main-model fallback.
 * @param {any} registry @param {string} transcript
 * @param {{ signal: AbortSignal, timeoutMs?: number, fakeMode?: boolean }} options
 */
export async function generateNativeLabel(registry, transcript, { signal, timeoutMs = LABEL_TIMEOUT_MS, fakeMode = false }) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs);
  let modelFacts = {};
  try {
    const small = (/** @type {any} */ model) => /haiku/iu.test(model.id) && (!fakeMode || model.provider === "native-session-demo-fake");
    const explicitAuth = (/** @type {any} */ model) =>
      ["stored", "runtime", "models_json_key", "models_json_command"].includes(registry?.getProviderAuthStatus?.(model.provider)?.source) ? 0 : 1;
    const models = (registry?.getAvailable?.() ?? []).filter(small).sort((/** @type {any} */ a, /** @type {any} */ b) =>
      explicitAuth(a) - explicitAuth(b) || (a.cost?.output ?? Infinity) - (b.cost?.output ?? Infinity) || `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
    const model = models[0];
    if (model === undefined) return { status: (registry?.getAll?.() ?? []).some(small) ? "unavailable-auth" : "unavailable-model" };
    modelFacts = { modelProvider: model.provider, modelId: model.id };
    const aborted = new Promise((resolve) => {
      if (controller.signal.aborted) resolve(undefined);
      else controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    const response = await Promise.race([aborted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return registry.complete(model, { messages: [{ role: "user", content: summaryPrompt(transcript), timestamp: Date.now() }] },
        { signal: controller.signal, timeoutMs, maxTokens: 512, maxRetries: 0, cacheRetention: "none" });
    })]);
    if (controller.signal.aborted) return { ...modelFacts, status: "timeout", failureReason: "timeout" };
    const stopReason = STOP_REASONS.includes(response?.stopReason) ? response.stopReason : "unknown";
    const diagnostics = { ...modelFacts, stopReason };
    if (stopReason !== "stop") return { ...diagnostics, status: stopReason === "error" ? "error" : "malformed", failureReason: "stop-reason" };
    /** @type {string} */
    const reply = response?.content?.filter((/** @type {any} */ part) => part.type === "text").map((/** @type {any} */ part) => part.text).join("\n") ?? "";
    if (reply.length > 4096) return { ...diagnostics, status: "malformed", failureReason: "oversized" };
    const lines = reply.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 2 || !/^Title:\s*\S/iu.test(lines[0]) || !/^Summary:\s*\S/iu.test(lines[1])) {
      return { ...diagnostics, status: "malformed", failureReason: "format" };
    }
    const parsed = parseSummaryReply(lines.join("\n"));
    const name = displayText(parsed.name, 48);
    const description = displayText(parsed.text, 240);
    if (name === undefined || description === undefined) return { ...diagnostics, status: "malformed", failureReason: "empty-label" };
    return { ...diagnostics, status: "ready", name, description };
  } catch {
    return { ...modelFacts, status: controller.signal.aborted ? "timeout" : "error", failureReason: controller.signal.aborted ? "timeout" : "request-failed" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
