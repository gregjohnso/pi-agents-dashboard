import { expect, it } from "vitest";

import { OWNER_SIDEBAND_SOCKET_ENV, OWNER_SIDEBAND_TOKEN_ENV } from "../runtime/native-sideband.mjs";
import { registerOwnerExtension } from "./pi-agents-owner.mjs";

const ENV = { [OWNER_SIDEBAND_SOCKET_ENV]: "/unused/socket", [OWNER_SIDEBAND_TOKEN_ENV]: "unused-token" };

/** A Pi extension API with the event bus, commands and session name an owner extension can reach. */
function fakePi() {
  const handlers = new Map();
  const channels = new Map();
  const commands = new Map();
  let sessionName;
  const pi = {
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    events: {
      emit(channel, data) { for (const handler of channels.get(channel) ?? []) handler(data); },
      on(channel, handler) { channels.set(channel, [...(channels.get(channel) ?? []), handler]); return () => {}; },
    },
    registerCommand(name, command) { commands.set(name, command); },
    getSessionName: () => sessionName,
    setSessionName: (name) => { sessionName = name; },
  };
  return {
    pi, commands,
    emit: async (event, payload, ctx) => { for (const handler of handlers.get(event) ?? []) await handler(payload, ctx); },
    /** The user's session-color extension, as far as the bus can see it. */
    sessionColor(initial = "default") {
      let color = initial;
      pi.events.on("session-color:set", (data) => { color = data.color; pi.events.emit("session-color:changed", { color }); });
      return { announce: () => pi.events.emit("session-color:changed", { color }) };
    },
  };
}

function fakeLink() {
  const facts = [];
  const receipts = [];
  let onRequest;
  return {
    facts, receipts, request: (request) => onRequest(request),
    link: {
      closed: new Promise(() => {}), close() {},
      onRequest(handler) { onRequest = handler; },
      announceBridgeReady: async () => {}, reportSeams: async () => {},
      publishFacts: async (published) => { facts.push(published); },
      sendReceipt: async (receipt) => { receipts.push(receipt); },
    },
  };
}

const ctx = { mode: "tui", hasUI: true, cwd: "/repo", ui: { setWidget() {}, notify() {} }, isIdle: () => true, hasPendingMessages: () => false };

async function started({ withSessionColor = true, initial = "default" } = {}) {
  const fake = fakePi();
  const color = withSessionColor ? fake.sessionColor(initial) : undefined;
  const bridge = fakeLink();
  const registration = registerOwnerExtension(fake.pi, { env: ENV, connect: async () => bridge.link });
  color?.announce();
  await fake.emit("session_start", { reason: "startup" }, ctx);
  await registration.whenBridgeSettled();
  return { fake, bridge, color, registration };
}

it("publishes the session's color, and says it can set one, only when session-color is present", async () => {
  const { bridge } = await started({ initial: "blue" });
  expect(bridge.facts.at(-1)).toMatchObject({ sessionColor: "blue", colorSupported: true });
  const without = await started({ withSessionColor: false });
  expect(without.bridge.facts.at(-1).sessionColor).toBeUndefined();
  expect(without.bridge.facts.at(-1).colorSupported).toBeUndefined();
});

it("republishes when /color changes inside the session", async () => {
  const { fake, bridge, registration } = await started();
  fake.pi.events.emit("session-color:changed", { color: "green" });
  await registration.whenBridgeSettled();
  expect(bridge.facts.at(-1)).toMatchObject({ sessionColor: "green" });
});

it("applies a color asked for from the list through session-color, and publishes it before answering", async () => {
  const { bridge } = await started();
  bridge.request({ requestId: "r1", request: "color", color: "red" });
  await expect.poll(() => bridge.receipts.length).toBe(1);
  expect(bridge.receipts[0]).toMatchObject({ requestId: "r1", request: "color", outcome: "requested" });
  expect(bridge.facts.at(-1)).toMatchObject({ sessionColor: "red" });
});

it("answers a color request it cannot apply as unsupported", async () => {
  const { bridge } = await started({ withSessionColor: false });
  bridge.request({ requestId: "r2", request: "color", color: "red" });
  await expect.poll(() => bridge.receipts.length).toBe(1);
  expect(bridge.receipts[0]).toMatchObject({ requestId: "r2", request: "color", outcome: "unsupported" });
});

it("registers /rename inside the session, setting Pi's own session name", async () => {
  const { fake } = await started();
  const notices = [];
  const commandCtx = { ...ctx, ui: { ...ctx.ui, notify: (text) => notices.push(text) } };
  await fake.commands.get("rename").handler("  Probe Session  ", commandCtx);
  expect(fake.pi.getSessionName()).toBe("Probe Session");
  await fake.commands.get("rename").handler("   ", commandCtx);
  expect(fake.pi.getSessionName()).toBe("Probe Session");
  expect(notices.at(-1)).toMatch(/Usage: \/rename <name>/u);
});

it("publishes how many monitors pi-monitor says are running", async () => {
  const { fake, bridge, registration } = await started();
  fake.pi.events.emit("pi-monitor:running", { count: 2 });
  await registration.whenBridgeSettled();
  expect(bridge.facts.at(-1)).toMatchObject({ monitorsRunning: 2 });
  fake.pi.events.emit("pi-monitor:running", { count: 0 });
  await registration.whenBridgeSettled();
  expect(bridge.facts.at(-1)).toMatchObject({ monitorsRunning: 0 });
});
