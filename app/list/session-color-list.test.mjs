import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it } from "vitest";

import { parseListCommand } from "./list-commands.mjs";
import { createNativeBackend } from "./native-backend.mjs";
import { jobwatchTheme } from "./dashboard-theme.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const choices = { models: [], isolationModes: ["worktree", "shared_directory"] };

it("parses /color with one of session-color's names", () => {
  expect(parseListCommand("/color red", choices)).toEqual({ kind: "color_session", color: "red" });
  expect(parseListCommand("/color Default", choices)).toEqual({ kind: "color_session", color: "default" });
  expect(parseListCommand("/color", choices)).toMatchObject({ kind: "rejected", code: "SESSION_COLOR_REQUIRED" });
  expect(parseListCommand("/color magenta", choices)).toMatchObject({ kind: "rejected", code: "SESSION_COLOR_UNKNOWN" });
});

it("tints a row's name in the colour the session chose", () => {
  const tinted = jobwatchTheme.name("probe", false, "red");
  expect(tinted).toContain("\x1b[48;2;255;95;95m");
  expect(stripVTControlCharacters(tinted)).toBe("probe");
});

async function backend(status, answer) {
  const dir = await mkdtemp(path.join(tmpdir(), "pia-color-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const sessionsHome = path.join(dir, "runtime");
  await mkdir(path.join(sessionsHome, "session-1700000000041"), { recursive: true });
  const frames = [];
  const client = createNativeBackend({
    sessionsHome,
    askControl: async (_root, frame) => {
      frames.push(frame);
      if (frame.type === "status") return { reachable: true, answer: { status } };
      if (frame.type === "color") return { reachable: true, answer: answer(frame) };
      throw new Error(`unexpected ${frame.type}`);
    },
  });
  cleanup.push(() => client.close());
  return { client, frames };
}

const live = (facts) => ({ owner: { pid: 1, startIdentity: "1" }, exit: null, bridge: { facts: { agentPhase: "settled", idle: true, ...facts } } });

it("shows the colour a session publishes on its row, and none for the default", async () => {
  const { client } = await backend(live({ sessionColor: "blue" }), () => ({}));
  expect((await client.getState()).sessions[0].color).toBe("blue");
  const plain = await backend(live({ sessionColor: "default" }), () => ({}));
  expect((await plain.client.getState()).sessions[0].color).toBeUndefined();
});

it("asks the session to change colour, and reports only the colour it confirmed", async () => {
  const { client, frames } = await backend(live({ sessionColor: "default", colorSupported: true }), (frame) => ({ sent: true, confirmedColor: frame.color }));
  await expect(client.setColor("session-1700000000041", 1, "req", "green")).resolves.toMatchObject({ color: "green", confirmed: true });
  expect(frames.at(-1)).toEqual({ type: "color", color: "green" });
  const refused = await backend(live({}), () => ({ sent: false, reason: "this owner generation does not advertise color support" }));
  await expect(refused.client.setColor("session-1700000000041", 1, "req", "green")).rejects.toMatchObject({ code: "COLOR_UNSUPPORTED" });
  const unconfirmed = await backend(live({ colorSupported: true }), () => ({ sent: true, confirmedColor: "default" }));
  await expect(unconfirmed.client.setColor("session-1700000000041", 1, "req", "green")).rejects.toMatchObject({ code: "COLOR_UNCONFIRMED" });
});

it("keeps an idle session WORKING while one of its background subagents runs", async () => {
  const { client } = await backend(live({ subagentsRunning: 2 }), () => ({}));
  const [row] = (await client.getState()).sessions;
  expect(row.taskState).toBe("WORKING");
  expect(row.activity.summary).toContain("2 subagents running");
});

it("keeps an idle session WORKING while one of its monitors runs", async () => {
  const { client } = await backend(live({ monitorsRunning: 1 }), () => ({}));
  const row = (await client.getState()).sessions[0];
  expect(row.taskState).toBe("WORKING");
  expect(row.activity.summary).toContain("1 monitor running");
  const idle = await backend(live({ monitorsRunning: 0 }), () => ({}));
  expect((await idle.client.getState()).sessions[0].taskState).toBe("READY");
});
