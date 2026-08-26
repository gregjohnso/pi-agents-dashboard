import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-file.mjs";

const MAX_SUMMARY_CHARS = 240;
const MAX_TRANSCRIPT_CHARS = 6_000;
const SUMMARY_TIMEOUT_MS = 60_000;
const PROMPT = [
  "Summarize what this coding session is doing and what it has produced so far.",
  "Answer in one line under 20 words, no preamble, no quotes, present tense.",
].join(" ");

/** Read and write the daemon's opt-in summary settings. @param {{ directory: string, fsOps?: any }} options */
export async function openSettingsStore({ directory, fsOps = fs }) {
  const path = join(directory, "settings.json");
  /** @type {{ summaryModel: { provider: string, id: string } | null }} */
  let settings = { summaryModel: null };
  try {
    const stored = JSON.parse(await fsOps.readFile(path, "utf8"));
    if (stored?.schemaVersion !== 1) throw new TypeError("Daemon settings schema is unsupported");
    const model = stored.summaryModel;
    if (model !== null && (typeof model?.provider !== "string" || typeof model?.id !== "string")) throw new TypeError("Daemon settings summary model is invalid");
    settings = { summaryModel: model === null ? null : { provider: model.provider, id: model.id } };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") throw Object.assign(new Error("Daemon settings are unreadable", { cause: error }), { code: "SETTINGS_CORRUPT" });
  }
  return {
    current() { return { summaryModel: settings.summaryModel === null ? null : { ...settings.summaryModel } }; },
    /** @param {{ provider: string, id: string } | null} summaryModel */
    async setSummaryModel(summaryModel) {
      settings = { summaryModel: summaryModel === null ? null : { ...summaryModel } };
      await atomicWriteJson(path, { schemaVersion: 1, summaryModel: settings.summaryModel });
      return this.current();
    },
  };
}

/** Render one bounded transcript excerpt for summarization. @param {any[]} items */
export function summarizePromptInput(items) {
  const lines = [];
  for (const item of items.slice(-40)) {
    if (item.kind === "user_message" || item.kind === "assistant_message") {
      const text = item.content.filter((/** @type {any} */ part) => part.type === "text").map((/** @type {any} */ part) => part.text).join(" ").replace(/\s+/gu, " ").trim();
      if (text.length > 0) lines.push(`${item.kind === "user_message" ? "User" : "Assistant"}: ${text}`);
    } else if (item.kind === "tool") lines.push(`Tool: ${item.toolId}`);
    else if (item.kind === "system_message") lines.push(`System: ${item.text}`);
  }
  const transcript = lines.join("\n");
  return transcript.length <= MAX_TRANSCRIPT_CHARS ? transcript : transcript.slice(-MAX_TRANSCRIPT_CHARS);
}

/**
 * Summarize one transcript with stock Pi's non-interactive print mode.
 * @param {{ executable: string, model: { provider: string, id: string }, transcript: string, env?: NodeJS.ProcessEnv, spawnImpl?: any, timeoutMs?: number }} options
 */
export async function summarizeWithPi({ executable, model, transcript, env = process.env, spawnImpl = spawn, timeoutMs = SUMMARY_TIMEOUT_MS }) {
  if (transcript.trim().length === 0) return undefined;
  const child = spawnImpl(executable, ["--print", "--no-session", "--no-tools", "--provider", model.provider, "--model", model.id, "--", `${PROMPT}\n\n${transcript}`], { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (/** @type {string | undefined} */ value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill?.("SIGKILL"); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    child.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) return finish(undefined);
      chunks.push(Buffer.from(chunk));
    });
    child.once("error", () => finish(undefined));
    child.once("exit", (/** @type {number | null} */ code) => {
      if (code !== 0) return finish(undefined);
      const text = Buffer.concat(chunks).toString("utf8").replace(/\s+/gu, " ").trim();
      finish(text.length === 0 ? undefined : text.slice(0, MAX_SUMMARY_CHARS));
    });
  });
}
