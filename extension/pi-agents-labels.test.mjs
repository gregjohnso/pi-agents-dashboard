import { afterEach, expect, it } from "vitest";
import { registerOwnerExtension } from "./pi-agents-owner.mjs";

const HAIKU = { provider: "configured-proxy", id: "claude-haiku-4-5", name: "Haiku", cost: { output: 5 } };
const REPLY = { stopReason: "stop", content: [{ type: "text", text: "Title: Repair native labels\nSummary: Describes the task without changing user names" }] };
const cleanup = [];
afterEach(async () => { for (const end of cleanup.splice(0)) await end(); });

async function owner({ name, complete = async () => REPLY, models = [HAIKU], available = models, timeoutMs = 100, env = {}, deferNameEvents = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const snapshots = [];
  let request;
  const connect = async () => {
    let resolveClosed;
    return {
      closed: new Promise((resolve) => { resolveClosed = resolve; }),
      close: () => resolveClosed({}),
      onRequest: (handler) => { request = handler; },
      announceBridgeReady: async () => {},
      publishFacts: async (facts) => { snapshots.push(facts); },
      sendReceipt: async (receipt) => { calls.push(receipt); },
    };
  };
  const emit = async (event, payload = {}, context = ctx) => {
    if (deferNameEvents && event === "session_info_changed") await new Promise((resolve) => setTimeout(resolve, 5));
    for (const handler of handlers.get(event) ?? []) await handler(payload, context);
  };
  const pi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getSessionName: () => name,
    setSessionName: (next) => { name = next || undefined; calls.push(next); void emit("session_info_changed", { name }); },
  };
  const registryCalls = [];
  const ctx = {
    sessionManager: { getSessionId: () => "pi-session-1", getSessionFile: () => "/private/pi.jsonl" },
    ui: { setWidget: () => {} },
    model: { provider: "main", id: "expensive-opus" },
    modelRegistry: {
      getAll: () => models,
      getAvailable: () => available,
      complete: async (...args) => { registryCalls.push(args); return complete(...args); },
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    shutdown: () => calls.push("shutdown"),
  };
  const registration = registerOwnerExtension(pi, {
    env: { PI_AGENTS_OWNER_SIDEBAND_SOCKET: "/private/o", PI_AGENTS_OWNER_SIDEBAND_TOKEN: "fixture-token", ...env },
    connect,
    labelTimeoutMs: timeoutMs,
  });
  const finish = async (prompt) => {
    await emit("before_agent_start", { prompt, messageType: "user" });
    await emit("message_end", { message: { role: "user", content: [{ type: "text", text: prompt }] } });
    await emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Completed the request" }] }] });
    await emit("agent_settled");
  };
  const twoRequests = async () => { await finish("hi"); await finish("Repair native session labels"); };
  cleanup.push(() => emit("session_shutdown"));
  await emit("session_start", { reason: "startup" });
  await registration.whenBridgeSettled();
  return { emit, finish, twoRequests, pi, ctx, calls, registryCalls, snapshots, facts: () => snapshots.at(-1), request: (value) => request(value) };
}

it("summarizes every finished turn, and titles only after two user requests with both prompts in context", async () => {
  const o = await owner();
  await o.finish("hi");
  await expect.poll(() => o.facts().labelStatus).toBe("ready");
  expect(o.registryCalls).toHaveLength(1);
  expect(o.pi.getSessionName()).toBeUndefined();
  await o.emit("before_agent_start", { prompt: "Repair native session labels", messageType: "user" });
  await o.emit("message_end", { message: { role: "user", content: "Repair native session labels" } });
  expect(o.registryCalls).toHaveLength(1);
  await o.emit("agent_end", { messages: [] });
  await o.emit("agent_settled");
  await expect.poll(() => o.pi.getSessionName()).toBe("Repair native labels");
  await expect.poll(() => o.facts().labelDescription).toBe("Describes the task without changing user names");
  const [model, context, options] = o.registryCalls[1];
  expect(model).toBe(HAIKU);
  expect(context.messages[0].content).toContain("User: hi");
  expect(context.messages[0].content).toContain("Repair native session labels");
  expect(context.tools).toBeUndefined();
  expect(options).toMatchObject({ maxTokens: 2048, maxRetries: 0, cacheRetention: "none" });
  expect(o.facts().sessionName).toBe(o.pi.getSessionName());
  await o.emit("agent_settled");
  expect(o.registryCalls).toHaveLength(2);
});

it("counts messages sent while a turn runs toward the title, with their text in its context", async () => {
  const o = await owner();
  await o.emit("before_agent_start", { prompt: "Regenerate lac-operon genes", messageType: "user" });
  for (const text of ["Regenerate lac-operon genes", "put it in a notebook", "use the 6b 1m context model"]) {
    await o.emit("message_end", { message: { role: "user", content: [{ type: "text", text }] } });
  }
  await o.emit("message_end", { message: { role: "custom", content: "[monitor] not a user request" } });
  await o.emit("agent_end", { messages: [] });
  await o.emit("agent_settled");
  await expect.poll(() => o.pi.getSessionName()).toBe("Repair native labels");
  expect(o.registryCalls[0][1].messages[0].content).toContain("use the 6b 1m context model");
  expect(o.registryCalls[0][1].messages[0].content).not.toContain("not a user request");
});

it("shows what the session was just asked while its turn runs", async () => {
  const o = await owner();
  await o.emit("before_agent_start", { prompt: "Compare zero-shot\n  BRCA1 results", messageType: "user" });
  expect(o.facts()).toMatchObject({ labelVersion: 1, labelDescription: "Compare zero-shot BRCA1 results" });
});

it("summarizes a turn a custom message started, such as a monitor event", async () => {
  const o = await owner();
  await o.emit("before_agent_start", { prompt: "[monitor ▸ sweep] 64 COMPLETED", messageType: "custom" });
  await o.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "All 64 tasks finished" }] }] });
  await o.emit("agent_settled");
  await expect.poll(() => o.facts().labelDescription).toBe("Describes the task without changing user names");
  expect(o.pi.getSessionName()).toBeUndefined();
});

it("keeps a newer turn's description when an earlier turn's summary lands late", async () => {
  let answer;
  const o = await owner({ complete: () => new Promise((resolve) => { answer = resolve; }) });
  await o.finish("first");
  await expect.poll(() => o.registryCalls.length).toBe(1);
  await o.emit("before_agent_start", { prompt: "Second task now running", messageType: "user" });
  answer(REPLY);
  await expect.poll(() => o.facts().labelStatus).toBe("ready");
  expect(o.facts().labelDescription).toBe("Second task now running");
});

it("writes one summary at a time, queueing the latest turn that ends meanwhile", async () => {
  const answers = [];
  const o = await owner({ complete: () => new Promise((resolve) => { answers.push(resolve); }) });
  await o.finish("first");
  await o.finish("second");
  await o.finish("third");
  await expect.poll(() => o.registryCalls.length).toBe(1);
  answers[0](REPLY);
  await expect.poll(() => o.registryCalls.length).toBe(2);
  expect(o.registryCalls[1][1].messages[0].content).toContain("third");
  answers[1](REPLY);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(o.registryCalls).toHaveLength(2);
});

it.each([false, true])("refreshes an automatic title once, including deferred name events: %j", async (deferNameEvents) => {
  let count = 0;
  const titles = ["Title: Greeting\nSummary: Said hello", "Title: First title\nSummary: Starting task", "Title: Better title\nSummary: Finished task", "Title: Churned title\nSummary: Later work"];
  const o = await owner({ deferNameEvents, complete: async () => ({ ...REPLY, content: [{ type: "text", text: titles[count++] }] }) });
  await o.twoRequests();
  await expect.poll(() => o.pi.getSessionName()).toBe("First title");
  await o.finish("More informative task details");
  await expect.poll(() => o.pi.getSessionName()).toBe("Better title");
  await expect.poll(() => o.facts().labelDescription).toBe("Finished task");
  await o.finish("Fourth request");
  await expect.poll(() => o.registryCalls.length).toBe(4);
  expect(o.pi.getSessionName()).toBe("Better title");
});

it.each(["Chosen by user", ""])("does not overwrite an explicit name or deliberate clear: %j", async (name) => {
  let answer;
  const o = await owner({ complete: () => new Promise((resolve) => { answer = resolve; }) });
  await o.twoRequests();
  await expect.poll(() => o.registryCalls.length).toBe(1);
  o.pi.setSessionName(name);
  answer(REPLY);
  await expect.poll(() => o.facts().labelStatus).toBe("ready");
  expect(o.pi.getSessionName()).toBe(name || undefined);
});

it("dashboard rename and an explicit launch name beat the initial and refresh completions", async () => {
  const o = await owner({ name: "Launch name" });
  await o.twoRequests();
  await expect.poll(() => o.facts().labelStatus).toBe("ready");
  expect(o.pi.getSessionName()).toBe("Launch name");
  o.request({ request: "rename", name: "User wins", requestId: "fixture-rename" });
  await o.finish("next task");
  await expect.poll(() => o.registryCalls.length).toBe(3);
  expect(o.pi.getSessionName()).toBe("User wins");
});

it("retries a failed title once on the next completed request, without a request loop", async () => {
  let count = 0;
  const o = await owner({ complete: async () => ++count === 2 ? { ...REPLY, stopReason: "length" } : REPLY });
  await o.twoRequests();
  await expect.poll(() => o.facts().labelStatus).toBe("malformed");
  expect(o.facts()).toMatchObject({ labelFailureReason: "stop-reason", labelStopReason: "length", labelModelId: HAIKU.id });
  expect(o.pi.getSessionName()).toBeUndefined();
  await o.emit("agent_settled");
  expect(o.registryCalls).toHaveLength(2);
  await o.finish("Clarify the implementation");
  await expect.poll(() => o.pi.getSessionName()).toBe("Repair native labels");
  await expect.poll(() => o.facts().labelStatus).toBe("ready");
  expect(o.facts().labelFailureReason).toBeUndefined();
  await o.finish("Fourth request");
  await expect.poll(() => o.registryCalls.length).toBe(4);
});

it.each([
  ["unavailable-model", { models: [{ provider: "main", id: "opus" }] }],
  ["unavailable-auth", { available: [] }],
  ["error", { complete: async () => { throw new Error("sensitive fixture error"); } }],
  ["malformed", { complete: async () => ({ ...REPLY, content: [{ type: "text", text: "not a two-line reply" }] }) }],
  ["timeout", { timeoutMs: 20, complete: () => new Promise(() => {}) }],
])("labels %s is bounded and nonfatal, retaining the placeholder", async (status, options) => {
  const o = await owner(options);
  await o.twoRequests();
  await expect.poll(() => o.facts().labelStatus).toBe(status);
  expect(o.pi.getSessionName()).toBeUndefined();
  expect(o.facts().agentPhase).toBe("settled");
  expect(JSON.stringify(o.snapshots)).not.toContain("sensitive fixture error");
});

it.each(["reload", "new", "stop"])("drops pending label effects after %s", async (reason) => {
  let answer;
  const o = await owner({ complete: () => new Promise((resolve) => { answer = resolve; }) });
  await o.twoRequests();
  await expect.poll(() => o.registryCalls.length).toBe(1);
  if (reason === "stop") o.request({ request: "stop", requestId: "stop-fixture" });
  else { await o.emit("session_shutdown", { reason }); await o.emit("session_start", { reason }); }
  answer(REPLY);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(o.pi.getSessionName()).toBeUndefined();
  expect(o.registryCalls[0][2].signal.aborted).toBe(true);
});

it("never calls real Haiku in sealed fake mode", async () => {
  const o = await owner({ env: { PI_DEMO_FAKE_PROVIDER: "1" } });
  await o.emit("before_agent_start", { prompt: "custom", messageType: "custom" });
  await o.emit("agent_settled");
  await o.finish("first user request");
  await o.finish("second user request");
  await expect.poll(() => o.facts().labelStatus).toBe("unavailable-model");
  expect(o.registryCalls).toHaveLength(0);
});

it("keeps the first request as the goal in every summary's context, however long the session runs", async () => {
  const o = await owner();
  for (const prompt of ["Compare BRCA1 zero-shot results", "second", "third", "fourth", "fifth"]) await o.finish(prompt);
  await expect.poll(() => o.registryCalls.at(-1)?.[1].messages[0].content ?? "").toContain("fifth");
  const context = o.registryCalls.at(-1)[1].messages[0].content;
  expect(context).toContain("Compare BRCA1 zero-shot results");
  expect(context).toContain("fifth");
});

it("shows the goal from the last summary beside a new request while its turn runs", async () => {
  const o = await owner({ complete: async () => ({ ...REPLY, content: [{ type: "text", text: "Title: BRCA1 eval\nSummary: BRCA1 zero-shot eval: scoring the 6B model" }] }) });
  await o.finish("start the eval");
  await expect.poll(() => o.facts().labelDescription).toBe("BRCA1 zero-shot eval: scoring the 6B model");
  await o.emit("before_agent_start", { prompt: "now plot the AUROC", messageType: "user" });
  expect(o.facts().labelDescription).toBe("BRCA1 zero-shot eval: now plot the AUROC");
});
