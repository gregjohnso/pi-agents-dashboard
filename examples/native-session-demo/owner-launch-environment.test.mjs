/**
 * The COMPLETE launch environment, which is where both final-environment defects lived.
 *
 * SCOPE: the user override in `durable-storage/NATIVE-STORAGE-SCOPE.md` — "just use whatever pi's storage system
 * is" — with supervisor option A. Pi owns normal configured storage; the demo contributes no storage path of its
 * own. These cases assert the **returned `plan.env`**, not a helper's intermediate result, because the two reviewed
 * P1s were both invisible at helper level:
 *
 *   - the helper's preserved operator value reached FAKE mode through shared plumbing, so a disposable fake launch
 *     could write into operator history;
 *   - the helper's "dropped" empty object did not actually drop anything in REAL mode, because real mode copies the
 *     inherited environment separately and `PI_CODING_AGENT_SESSION_DIR` was not stripped from it.
 *
 * The old/new demo distinction is derived from known old plumbing, not from a provenance framework: the superseded
 * demo pointed Pi at `<runtime root>/sessions` addressed through the manager's `/proc/<pid>/fd/<n>` anchor, so a
 * descriptor-alias session directory is recognisably that plumbing and nothing an operator would configure. The
 * current demo also sets `PI_DEMO_CONTROL_SOCKET`, so the marker alone must NOT condemn a setting — the sibling
 * case below pins that.
 *
 * Nothing here spawns Pi, reads a normal-account path, or touches live state: `ownerLaunchPlan` is pure.
 */

import { describe, expect, it } from "vitest";

import { ownerLaunchPlan } from "./owner-launch.mjs";

const OWNED = {
  home: "/run/root/home",
  agent: "/run/root/agent",
  sessions: "/run/root/sessions",
  project: "/run/root/project",
  bootstrapSocket: "/run/root/b",
  controlSocket: "/run/root/s",
  sidebandSocket: "/run/root/bridge/g",
  ingressLog: "/run/root/owner-preload.jsonl",
};

/** One plan input. `inheritedEnv` is always explicit so no case can read the real environment. */
function planInput(overrides = {}) {
  return {
    mode: "fake",
    preload: "/code/owner-preload.mjs",
    extension: "/code/owner-extension.ts",
    bundledCli: "/cohort/cli.js",
    tuiPackageRoot: "/cohort/pi-tui",
    profile: { term: "xterm-256color" },
    cols: 100,
    rows: 30,
    owned: OWNED,
    token: "control-token",
    bridgeToken: "bridge-token",
    sidebandSocketEnv: "PI_AGENTS_OWNER_SIDEBAND_SOCKET",
    sidebandTokenEnv: "PI_AGENTS_OWNER_SIDEBAND_TOKEN",
    fakeProviderId: "native-session-demo-fake",
    fakeModelId: "deterministic-echo",
    inheritedEnv: {},
    ...overrides,
  };
}

const OPERATOR_SETTING = "/home/operator/my-own-histories";
/** Exactly the shape the superseded demo produced: the manager's held-descriptor anchor. */
const OLD_DEMO_TRANSIENT = "/proc/12345/fd/20/sessions";

describe("real mode: Pi's own storage decision, applied to the final environment", () => {
  it("names the dashboard session in Pi's environment, so its tools can send as it", () => {
    for (const mode of ["real", "fake"]) {
      const plan = ownerLaunchPlan(planInput({ mode, sessionId: "session-1700000000042", inheritedEnv: { HOME: "/home/operator", PI_AGENTS_SESSION_ID: "session-parent" } }));
      expect(plan.env.PI_AGENTS_SESSION_ID).toBe("session-1700000000042");
    }
  });

  it("omits the session directory entirely when nothing set one", () => {
    const plan = ownerLaunchPlan(planInput({ mode: "real", inheritedEnv: { HOME: "/home/operator", PATH: "/usr/bin" } }));
    // An omitted override must actually stay omitted, so Pi falls back to its own configuration.
    expect(Object.hasOwn(plan.env, "PI_CODING_AGENT_SESSION_DIR")).toBe(false);
  });

  it("preserves an operator's own configured session directory", () => {
    const plan = ownerLaunchPlan(planInput({ mode: "real", inheritedEnv: { HOME: "/home/operator", PI_CODING_AGENT_SESSION_DIR: OPERATOR_SETTING } }));
    expect(plan.env.PI_CODING_AGENT_SESSION_DIR).toBe(OPERATOR_SETTING);
  });

  it("still preserves an operator's setting when a CURRENT demo's marker is also present", () => {
    // The sibling case. The current native-storage demo exports PI_DEMO_CONTROL_SOCKET too, so the marker alone
    // must not discard an intentional operator setting.
    const plan = ownerLaunchPlan(planInput({
      mode: "real",
      inheritedEnv: { HOME: "/home/operator", PI_CODING_AGENT_SESSION_DIR: OPERATOR_SETTING, PI_DEMO_CONTROL_SOCKET: "/run/other/s" },
    }));
    expect(plan.env.PI_CODING_AGENT_SESSION_DIR).toBe(OPERATOR_SETTING);
  });

  it("REMOVES an old-demo transient descriptor-alias directory from the final environment", () => {
    const plan = ownerLaunchPlan(planInput({
      mode: "real",
      inheritedEnv: { HOME: "/home/operator", PI_CODING_AGENT_SESSION_DIR: OLD_DEMO_TRANSIENT, PI_DEMO_CONTROL_SOCKET: "/run/other/s" },
    }));
    // Not merely "an empty override was spread": the key must be gone from the environment Pi receives.
    expect(Object.hasOwn(plan.env, "PI_CODING_AGENT_SESSION_DIR")).toBe(false);
  });

  it("removes an old-demo transient directory even without the demo marker", () => {
    // The discriminator is the known old plumbing shape, not the marker.
    const plan = ownerLaunchPlan(planInput({ mode: "real", inheritedEnv: { HOME: "/home/operator", PI_CODING_AGENT_SESSION_DIR: "/proc/self/fd/7/sessions" } }));
    expect(Object.hasOwn(plan.env, "PI_CODING_AGENT_SESSION_DIR")).toBe(false);
  });

  it("leaves the operator's own HOME and configuration directory untouched", () => {
    const plan = ownerLaunchPlan(planInput({ mode: "real", inheritedEnv: { HOME: "/home/operator", PI_CODING_AGENT_DIR: "/home/operator/.pi" } }));
    expect(plan.env.HOME).toBe("/home/operator");
    expect(plan.env.PI_CODING_AGENT_DIR).toBe("/home/operator/.pi");
  });
});

describe("fake mode: never the operator's storage, whatever the ambient environment says", () => {
  for (const [label, ambient] of [
    ["an operator setting", OPERATOR_SETTING],
    ["an old-demo transient directory", OLD_DEMO_TRANSIENT],
  ]) {
    it(`does not carry ${label} into the fake launch environment (no private config home)`, () => {
      const plan = ownerLaunchPlan(planInput({ mode: "fake", inheritedEnv: { PI_CODING_AGENT_SESSION_DIR: ambient, HOME: "/home/operator" } }));
      expect(Object.hasOwn(plan.env, "PI_CODING_AGENT_SESSION_DIR")).toBe(false);
      // The disposable legacy fallbacks, unchanged.
      expect(plan.env.HOME).toBe(OWNED.home);
      expect(plan.env.PI_CODING_AGENT_DIR).toBe(OWNED.agent);
    });

    it(`does not carry ${label} into the fake launch environment (with a private config home)`, () => {
      const plan = ownerLaunchPlan(planInput({
        mode: "fake",
        piConfigHome: "/fixture/pi-config",
        inheritedEnv: { PI_CODING_AGENT_SESSION_DIR: ambient, HOME: "/home/operator" },
      }));
      expect(Object.hasOwn(plan.env, "PI_CODING_AGENT_SESSION_DIR")).toBe(false);
      // Pi resolves its own storage under the private fixture configuration.
      expect(plan.env.HOME).toBe("/fixture/pi-config");
      expect(plan.env.PI_CODING_AGENT_DIR).toBe("/fixture/pi-config/.pi");
    });
  }

  it("keeps the fake environment a replaced one: no operator HOME leaks in", () => {
    const plan = ownerLaunchPlan(planInput({
      mode: "fake",
      inheritedEnv: { HOME: "/home/operator", PI_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret" },
    }));
    expect(plan.env.HOME).toBe(OWNED.home);
    expect(Object.hasOwn(plan.env, "PI_API_KEY")).toBe(false);
    expect(Object.hasOwn(plan.env, "AWS_SECRET_ACCESS_KEY")).toBe(false);
    expect(plan.env.PI_OFFLINE).toBe("1");
    expect(plan.env.JITI_FS_CACHE).toBe("false");
  });
});
