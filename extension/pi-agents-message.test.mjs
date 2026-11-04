import { expect, it } from "vitest";

import { OWNER_SIDEBAND_SOCKET_ENV, OWNER_SIDEBAND_TOKEN_ENV } from "../runtime/native-sideband.mjs";
import { registerOwnerExtension } from "./pi-agents-owner.mjs";

const ENV = { [OWNER_SIDEBAND_SOCKET_ENV]: "/unused/socket", [OWNER_SIDEBAND_TOKEN_ENV]: "unused-token" };
const ctx = { mode: "tui", hasUI: true, cwd: "/repo", ui: { setWidget() {}, notify() {} }, isIdle: () => true, hasPendingMessages: () => false };

async function started({ sendMessage = true } = {}) {
  const handlers = new Map();
  const delivered = [];
  const pi = {
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    events: { emit() {}, on() { return () => {}; } },
    ...(sendMessage ? { sendMessage: (message, options) => delivered.push({ message, options }) } : {}),
  };
  const facts = [];
  const receipts = [];
  let onRequest;
  const link = { closed: new Promise(() => {}), close() {}, onRequest(handler) { onRequest = handler; }, announceBridgeReady: async () => {}, reportSeams: async () => {},
    publishFacts: async (published) => { facts.push(published); }, sendReceipt: async (receipt) => { receipts.push(receipt); } };
  const registration = registerOwnerExtension(pi, { env: ENV, connect: async () => link });
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  await registration.whenBridgeSettled();
  return { delivered, facts, receipts, request: (request) => onRequest(request) };
}

it("advertises that it can receive messages only when Pi offers sendMessage", async () => {
  expect((await started()).facts.at(-1)).toMatchObject({ messageSupported: true });
  expect((await started({ sendMessage: false })).facts.at(-1).messageSupported).toBeUndefined();
});

it("delivers a message as a visible turn-starting follow-up naming the sender and how to reply", async () => {
  const s = await started();
  s.request({ requestId: "m1", request: "message", text: "the fold job finished", from: "session-1700000000001", fromName: "sae steering", interrupt: false });
  await expect.poll(() => s.receipts.length).toBe(1);
  expect(s.receipts[0]).toMatchObject({ requestId: "m1", request: "message", outcome: "requested" });
  const [{ message, options }] = s.delivered;
  expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  expect(message).toMatchObject({ customType: "pi-agents-message", display: true, details: { from: "session-1700000000001", fromName: "sae steering" } });
  expect(message.content).toContain("sae steering");
  expect(message.content).toContain("the fold job finished");
  expect(message.content).toContain('pi-agents send session-1700000000001 "');
});

it("steers a running turn when the sender asks to interrupt", async () => {
  const s = await started();
  s.request({ requestId: "m2", request: "message", text: "stop and check the logs", from: "session-1700000000001", fromName: "", interrupt: true });
  await expect.poll(() => s.delivered.length).toBe(1);
  expect(s.delivered[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
});
