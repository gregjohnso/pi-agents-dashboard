/**
 * The list-to-Pi-to-list flow, and the two modes the owner can be launched in.
 *
 * These cases cover the three things that are new and easy to get wrong:
 *
 *   1. the return gesture is attributed to exactly one attachment, and refuses rather than guessing;
 *   2. the shortcut this demo asks Pi to recognise collides with nothing Pi already binds;
 *   3. real mode carries the operator's own configuration and *none* of fake mode's pins, while fake mode
 *      stays sealed. This is asserted on the constructed plan, so no test ever needs a credential or a model.
 *
 * The end-to-end flow through the real list path lives in `list-flow.mjs` and is exercised by the SLURM
 * evidence run, for the same reason the existing acceptance smoke is: it needs real terminals and a real Pi.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCohort } from "./cohort.mjs";
import { FAKE_MODEL_ID, FAKE_PROVIDER_ID } from "./fake-provider.mjs";
import { OWNER_PRIVATE_ENV_KEYS, ownerLaunchPlan } from "./owner-launch.mjs";
import { describeSession, renderList } from "./list-demo.mjs";
import {
  RETURN_SHORTCUT,
  attributeReturn,
  clearInputProvenance,
  currentInputProvenance,
  noteInputProvenance,
  provideReturnRequest,
  requestReturn,
} from "./return-channel.mjs";

/** One sender, published once, so no case depends on another case's publication order. */
const asked = [];
provideReturnRequest((origin) => asked.push(origin));

/** One single-origin provenance, shaped exactly as Pi delivers it. */
function provenance(overrides = {}) {
  return {
    sequenceId: "seq-1",
    origin: { attachmentId: "client-a", epoch: 1 },
    mixedOrigin: false,
    bindingGeneration: 1,
    mixedBindingGeneration: false,
    ...overrides,
  };
}

/** One plan input that names every path, so a case can assert on any of them without rebuilding it. */
function planInput(overrides = {}) {
  return {
    mode: "fake",
    preload: "/demo/owner-preload.mjs",
    extension: "/demo/owner-extension.ts",
    bundledCli: "/cohort/cli.js",
    tuiPackageRoot: "/cohort/pi-tui",
    profile: { term: "xterm-256color" },
    cols: 100,
    rows: 30,
    owned: {
      home: "/root/home",
      agent: "/root/agent",
      sessions: "/root/sessions",
      project: "/root/project",
      bootstrapSocket: "/root/bootstrap.sock",
      controlSocket: "/root/control.sock",
      sidebandSocket: "/root/sideband.sock",
      ingressLog: "/root/ingress.jsonl",
    },
    token: "control-token",
    bridgeToken: "bridge-token",
    sidebandSocketEnv: "PI_AGENTS_OWNER_SIDEBAND_SOCKET",
    sidebandTokenEnv: "PI_AGENTS_OWNER_SIDEBAND_TOKEN",
    fakeProviderId: FAKE_PROVIDER_ID,
    fakeModelId: FAKE_MODEL_ID,
    ...overrides,
  };
}

// Attribution comes from Pi's own parsed-sequence provenance. These cases pin the decision table; the same
// decisions are exercised against the real terminal's real framing by `attribution-cases.mjs`.
describe("the return gesture's attribution", () => {
  it("refuses when Pi delivered no provenance, and asks the manager for nothing", () => {
    const before = asked.length;
    clearInputProvenance();
    const outcome = requestReturn();
    expect(outcome.requested).toBe(false);
    expect(outcome.reason).toMatch(/no provenance/u);
    expect(asked.length).toBe(before);
  });

  it("asks the manager for exactly the attachment epoch Pi named", () => {
    const before = asked.length;
    noteInputProvenance(provenance({ origin: { attachmentId: "client-b", epoch: 7 } }));
    const outcome = requestReturn();
    expect(outcome.requested).toBe(true);
    expect(outcome.origin).toEqual({ attachmentId: "client-b", epoch: 7 });
    // Named by id AND epoch: a stale epoch must not detach whatever now holds that id.
    expect(asked.slice(before)).toEqual([{ attachmentId: "client-b", epoch: 7 }]);
  });

  it("detaches nobody when native framing assembled the key from two attachments", () => {
    const before = asked.length;
    const decision = attributeReturn(provenance({ mixedOrigin: true }));
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/more than one attachment/u);
    noteInputProvenance(provenance({ mixedOrigin: true }));
    expect(requestReturn().requested).toBe(false);
    expect(asked.length).toBe(before);
  });

  it("detaches nobody when the key was assembled across two binding generations", () => {
    const before = asked.length;
    noteInputProvenance(provenance({ mixedBindingGeneration: true }));
    const outcome = requestReturn();
    expect(outcome.requested).toBe(false);
    expect(outcome.reason).toMatch(/two binding generations/u);
    expect(asked.length).toBe(before);
  });

  it("refuses a key that did not come from an attachment at all", () => {
    // Ordinary local stdin on the owner's own terminal: a real key with no attachment identity.
    expect(attributeReturn(provenance({ origin: null })).ok).toBe(false);
    expect(attributeReturn(provenance({ origin: null })).reason).toMatch(/did not arrive from an attachment/u);
  });

  it("refuses an origin that is not a usable attachment epoch instead of coercing it", () => {
    expect(attributeReturn(provenance({ origin: { attachmentId: "", epoch: 1 } })).ok).toBe(false);
    expect(attributeReturn(provenance({ origin: { attachmentId: "client-a", epoch: 1.5 } })).ok).toBe(false);
  });

  it("consumes the provenance, so a later gesture cannot reuse a stale one", () => {
    noteInputProvenance(provenance());
    expect(currentInputProvenance()).not.toBeUndefined();
    expect(requestReturn().requested).toBe(true);
    // Consumed by the first gesture: the second has nothing of its own and must refuse.
    expect(currentInputProvenance()).toBeUndefined();
    expect(requestReturn().requested).toBe(false);
  });

  it("clears what it holds when Pi delivers a sequence with no provenance", () => {
    noteInputProvenance(provenance());
    noteInputProvenance(undefined);
    expect(currentInputProvenance()).toBeUndefined();
    expect(requestReturn().requested).toBe(false);
  });
});

describe("the shortcut this demo asks Pi to recognise", () => {
  it("is a key the installed Pi can match, and one its own built-in keybindings leave free", async () => {
    const cohort = resolveCohort({});
    const tuiEntry = path.join(cohort.tuiPackageRoot, "dist");
    const keys = await import(`file://${path.join(tuiEntry, "keys.js")}`);
    // The real matcher, against the real sequence an f9 key press produces.
    expect(keys.matchesKey("\u001b[20~", RETURN_SHORTCUT)).toBe(true);
    // A modified f9 is not this gesture, so a chord cannot trigger a detach by accident.
    expect(keys.matchesKey("\u001b[20;5~", RETURN_SHORTCUT)).toBe(false);

    // Non-vacuous: the real binding table is loaded, asserted non-empty, and then searched.
    const { TUI_KEYBINDINGS } = await import(`file://${path.join(tuiEntry, "keybindings.js")}`);
    const actions = Object.entries(TUI_KEYBINDINGS);
    expect(actions.length).toBeGreaterThan(10);
    const bound = actions.flatMap(([action, binding]) => {
      const defaults = binding.defaultKeys ?? [];
      return (Array.isArray(defaults) ? defaults : [defaults]).map((key) => ({ action, key }));
    });
    expect(bound.length).toBeGreaterThan(10);
    expect(bound.filter(({ key }) => key === RETURN_SHORTCUT)).toEqual([]);
  });

  it("is absent from the shipped keybindings documentation's binding tables", async () => {
    const cohort = resolveCohort({});
    const docs = path.join(cohort.consumerRoot, "node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md");
    const text = await readFile(docs, "utf8");
    // Non-vacuous: the document really is the binding reference, and it binds no function key at all.
    expect(text).toContain("tui.input.submit");
    expect(text.includes(`\`${RETURN_SHORTCUT}\``)).toBe(false);
  });

  it("does not collide with the keys the editor and application already own", () => {
    // Enter, and every Return variant, stay the editor's. The gesture is deliberately not a Return key: seam
    // C's `authorizeReturn` only ever fires for one, and claiming it would take submit or newline.
    expect(RETURN_SHORTCUT).not.toMatch(/enter|return/iu);
    expect(RETURN_SHORTCUT).toMatch(/^f(?:[1-9]|1[0-2])$/u);
  });
});

describe("the list the operator reads", () => {
  const live = {
    root: "/sessions/session-1",
    name: "session-1",
    live: true,
    owner: { pid: 4321, startIdentity: "99" },
    attachments: 0,
    geometry: { cols: 100, rows: 30 },
    provider: "native-session-demo-fake/deterministic-echo (FAKE: deterministic, no model is called)",
    providerIsFake: true,
    ownerMode: "fake",
    returns: 0,
    detail: null,
  };

  it("describes a row from owner facts, not from anything rendered", () => {
    expect(describeSession(live)).toContain("pid 4321");
    expect(describeSession(live)).toContain("running, nobody attached");
    expect(describeSession({ ...live, attachments: 2 })).toContain("running, 2 attached");
  });

  it("shows a session whose owner is gone as not running, with the reason, rather than hiding it", () => {
    const dead = { root: "/sessions/session-2", name: "session-2", live: false, detail: "no control socket" };
    expect(describeSession(dead)).toContain("not running");
    expect(describeSession(dead)).toContain("no control socket");
  });

  it("tells the operator the return key, and which mode the list is in", () => {
    const fake = renderList({ sessions: [live], selected: 0, sessionsHome: "/sessions", mode: "fake", message: "" }).join("\n");
    expect(fake).toContain(RETURN_SHORTCUT.toUpperCase());
    expect(fake).toContain("the session keeps running");
    expect(fake).toContain("no model is called");
    const real = renderList({ sessions: [live], selected: 0, sessionsHome: "/sessions", mode: "real", message: "" }).join("\n");
    expect(real).toContain("REAL: your own Pi configuration");
  });

  it("marks the selected row and says so when there is nothing yet", () => {
    const two = renderList({ sessions: [live, { ...live, name: "session-2" }], selected: 1, sessionsHome: "/s", mode: "fake" });
    expect(two.find((line) => line.startsWith(">"))).toContain("session-2");
    expect(renderList({ sessions: [], selected: 0, sessionsHome: "/s", mode: "fake" }).join("\n")).toContain("no sessions yet");
  });
});

describe("fake mode stays sealed", () => {
  it("replaces the environment, pins the labelled fake provider and turns tools off", () => {
    const plan = ownerLaunchPlan(planInput({ mode: "fake" }));
    expect(plan.env.PATH).toBe("/usr/bin:/bin");
    expect(plan.env.HOME).toBe("/root/home");
    expect(plan.env.PI_CODING_AGENT_DIR).toBe("/root/agent");
    // Pi owns storage and selects its own session directory from the private configuration above. This demo sets no
    // session-directory override in either mode, so the strong isolation assertion is that the key is ABSENT: were
    // it present it could only have come from the ambient environment, which is exactly the leak that is refused.
    expect(Object.hasOwn(plan.env, "PI_CODING_AGENT_SESSION_DIR")).toBe(false);
    expect(plan.env.PI_OFFLINE).toBe("1");
    expect(plan.args).toContain("-nt");
    expect(plan.args).toContain("--no-extensions");
    expect(plan.args.join(" ")).toContain(`--provider ${FAKE_PROVIDER_ID} --model ${FAKE_MODEL_ID}`);
    expect(plan.describesProvider).toEqual({ label: expect.stringContaining("FAKE"), isFake: true });
    // Nothing of an operator's can reach it: the environment is a closed list, not an inheritance.
    expect(Object.keys(plan.env).some((key) => /API_KEY|TOKEN$/u.test(key) && !key.startsWith("PI_"))).toBe(false);
  });

  it("ignores an inherited environment entirely", () => {
    const plan = ownerLaunchPlan(planInput({ mode: "fake", inheritedEnv: { ANTHROPIC_API_KEY: "secret", PATH: "/operator/bin" } }));
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.env.PATH).toBe("/usr/bin:/bin");
  });
});

describe("real mode carries the operator's own configuration", () => {
  const inheritedEnv = {
    PATH: "/operator/bin:/usr/bin",
    HOME: "/home/operator",
    ANTHROPIC_API_KEY: "operator-credential",
    // Left over from a live demo session this manager was started inside.
    PI_DEMO_CONTROL_SOCKET: "/previous/control.sock",
    PI_DEMO_TOKEN: "previous-token",
    PI_DEMO_PROFILE: '{"term":"previous"}',
    PI_DEMO_LOG: "/previous/ingress.jsonl",
    PI_DEMO_TUI_PACKAGE: "/previous/pi-tui",
    PI_NATIVE_BOOTSTRAP_SOCKET: "/previous/bootstrap.sock",
    PI_AGENTS_OWNER_SIDEBAND_SOCKET: "/previous/sideband.sock",
    PI_AGENTS_OWNER_SIDEBAND_TOKEN: "previous-bridge-token",
    // Fake mode's own switch, which a nested real launch must not inherit.
    PI_DEMO_FAKE_PROVIDER: "1",
    NODE_OPTIONS: "--import /previous/owner-preload.mjs",
  };

  it("forces no fake provider, no -nt and no offline mode", () => {
    const plan = ownerLaunchPlan(planInput({ mode: "real", inheritedEnv }));
    expect(plan.args).not.toContain("-nt");
    expect(plan.args).not.toContain("--provider");
    expect(plan.args).not.toContain("--model");
    expect(plan.args).not.toContain("--no-extensions");
    expect(plan.args.join(" ")).not.toContain(FAKE_PROVIDER_ID);
    expect(plan.env.PI_OFFLINE).toBeUndefined();
    // It must not claim to know what answered; Pi resolves that.
    expect(plan.describesProvider.isFake).toBe(false);
    expect(plan.describesProvider.label).not.toMatch(/FAKE/u);
  });

  it("keeps their PATH, config directory and credentials, and still loads this demo's extension", () => {
    const plan = ownerLaunchPlan(planInput({ mode: "real", inheritedEnv }));
    expect(plan.env.PATH).toBe("/operator/bin:/usr/bin");
    expect(plan.env.HOME).toBe("/home/operator");
    // Their configuration directory is untouched, which is what lets Pi resolve its normal auth and models.
    expect(plan.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(plan.args.join(" ")).toContain("-e /demo/owner-extension.ts");
  });

  it("sets no session-directory override, so Pi's own configuration selects the store", () => {
    // Superseded expectation replaced: this used to require `/root/sessions`, the demo's own transient redirection.
    // Under the native-storage scope Pi chooses, and the supplied inherited environment carries no override, so the
    // key must be absent rather than invented.
    const plan = ownerLaunchPlan(planInput({ mode: "real", inheritedEnv }));
    expect(Object.hasOwn(plan.env, "PI_CODING_AGENT_SESSION_DIR")).toBe(false);
  });

  it("strips a previous owner's plumbing rather than inheriting its socket, token or preload", () => {
    const plan = ownerLaunchPlan(planInput({ mode: "real", inheritedEnv }));
    expect(plan.env.PI_DEMO_CONTROL_SOCKET).toBe("/root/control.sock");
    expect(plan.env.PI_DEMO_TOKEN).toBe("control-token");
    expect(plan.env.PI_NATIVE_BOOTSTRAP_SOCKET).toBe("/root/bootstrap.sock");
    expect(plan.env.PI_AGENTS_OWNER_SIDEBAND_TOKEN).toBe("bridge-token");
    expect(plan.env.NODE_OPTIONS).toBeUndefined();
    // Every private key is set from this owner's own plumbing or absent, and never the inherited value. The
    // inherited environment above sets all of them, so no entry here is vacuously undefined on both sides.
    for (const key of OWNER_PRIVATE_ENV_KEYS) {
      expect(inheritedEnv[key]).toBeDefined();
      expect(plan.env[key]).not.toBe(inheritedEnv[key]);
    }
  });

  it("does not inherit fake mode's provider switch, so a nested real launch registers no echo provider", () => {
    // A real owner started from inside a fake session would otherwise see PI_DEMO_FAKE_PROVIDER=1 and register
    // the labelled echo provider beside the operator's real one.
    const plan = ownerLaunchPlan(planInput({ mode: "real", inheritedEnv: { ...inheritedEnv, PI_DEMO_FAKE_PROVIDER: "1" } }));
    expect(plan.env.PI_DEMO_FAKE_PROVIDER).toBeUndefined();
    expect(OWNER_PRIVATE_ENV_KEYS).toContain("PI_DEMO_FAKE_PROVIDER");
    // Fake mode is the only thing that sets it, and it still does.
    expect(ownerLaunchPlan(planInput({ mode: "fake" })).env.PI_DEMO_FAKE_PROVIDER).toBe("1");
  });

  it("runs in the project directory the operator chose", () => {
    const plan = ownerLaunchPlan(planInput({ mode: "real", inheritedEnv, cwd: "/home/operator/work" }));
    expect(plan.cwd).toBe("/home/operator/work");
  });

  it("refuses a mode it does not know instead of falling back to either", () => {
    expect(() => ownerLaunchPlan(planInput({ mode: "offline" }))).toThrowError(/unknown owner mode/u);
  });
});
