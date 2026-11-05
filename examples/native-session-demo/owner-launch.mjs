/**
 * What this demo runs as the owner, and the one place the two modes are kept apart.
 *
 * There are exactly two modes, and the difference is deliberately visible in one function rather than spread
 * through the manager:
 *
 *   **fake** — what every test and the original `start` command use. A *replaced* environment, a labelled fake
 *   provider pinned on the command line, tools off, offline forced, and a private HOME and config directory.
 *   Nothing of the operator's reaches it, so a test can never spend a credential or call a model, and Pi
 *   resolves its session directory from that private configuration rather than from anything ambient.
 *
 *   **real** — what the operator gets when they ask for it themselves. Pi resolves its own normal
 *   configuration: their model selection, their credentials, their tools, their extensions, their PATH, in
 *   their chosen project directory. This mode names no provider and no model, because choosing one here would
 *   override the selection Pi is supposed to make and would let this demo mislabel what answered. Their session
 *   is stored where their own configuration puts it, exactly as a direct Pi run would store it.
 *
 * Two things are true in *both* modes, and they are the reason this is one function:
 *
 *   - **Pi owns storage.** Neither mode redirects `PI_CODING_AGENT_SESSION_DIR` to a path of this demo's own, so
 *     no transcript is written into a disposable socket root and nothing here copies or rewrites session
 *     content. The only decision made about that variable is whether an INHERITED one survives, which
 *     `sessionDirectoryDecision` below answers; superseded versions of this demo did redirect it, and a value
 *     left over from one of those is discarded rather than passed on.
 *   - this owner's own bootstrap socket, control socket, token, profile and preload are set here and stripped
 *     from anything inherited. A manager started from inside a live demo session would otherwise hand the new
 *     Pi the *previous* owner's socket and token, and two owners would answer on one channel.
 */

import path from "node:path";
import { isNativeSessionName } from "../../runtime/native-sideband.mjs";

/**
 * Variables that name a *particular* owner's private plumbing. Inherited copies are removed before this
 * owner's own are set, so a nested launch can never adopt an older session's channel. `NODE_OPTIONS` is in the
 * list because it can carry `--import`: the preload is passed explicitly on the command line, and a second one
 * arriving through the environment would register a competing host.
 */
export const OWNER_PRIVATE_ENV_KEYS = [
  "PI_NATIVE_BOOTSTRAP_SOCKET",
  "PI_DEMO_TUI_PACKAGE",
  "PI_DEMO_CONTROL_SOCKET",
  "PI_DEMO_TOKEN",
  "PI_DEMO_PROFILE",
  "PI_DEMO_LOG",
  // The initial task this owner was launched to run. Inherited into a nested launch it would make a new
  // session silently re-run an older session's prompt, so it is stripped like every other owner-private
  // value and set only from this launch's own plan.
  "PI_DEMO_INITIAL_PROMPT_FILE",
  // Fake mode's own switch. Inherited into a real launch it would make this demo's extension register the
  // labelled echo provider beside the operator's real one, which is exactly the mislabelling real mode exists
  // to avoid. It is set by fake mode and by nothing else, so stripping it here is what makes a real owner
  // started from inside a fake session still a real owner.
  "PI_DEMO_FAKE_PROVIDER",
  "PI_AGENTS_OWNER_SIDEBAND_SOCKET",
  "PI_AGENTS_OWNER_SIDEBAND_TOKEN",
  "NODE_OPTIONS",
];

/**
 * Build the argv and environment for one owner.
 *
 * @param {{
 *   mode: "fake" | "real",
 *   preload: string, extension: string, bundledCli: string, tuiPackageRoot: string,
 *   profile: { term: string }, cols: number, rows: number,
 *   owned: { home: string, agent: string, sessions: string, project: string, bootstrapSocket: string, controlSocket: string, sidebandSocket: string, ingressLog: string },
 *   token: string, bridgeToken: string,
 *   sidebandSocketEnv: string, sidebandTokenEnv: string,
 *   fakeProviderId: string, fakeModelId: string,
 *   cwd?: string,
 *   piConfigHome?: string,
 *   inheritedEnv?: Record<string, string | undefined>,
 * }} options
 * @returns {{ args: string[], env: Record<string, string>, cwd: string, describesProvider: { label: string, isFake: boolean } }}
 */
/**
 * The superseded demo's own transient session directory, recognised by its shape.
 *
 * That demo pointed Pi at `<runtime root>/sessions` addressed through the manager's held-descriptor anchor, so the
 * value always contained a `/proc/<pid>/fd/<n>/` segment. Such a path stops resolving the moment that manager
 * exits, and no operator configures one, which is why this shape — known old plumbing — is the discriminator
 * rather than any new provenance or configuration framework.
 *
 * The demo marker is deliberately NOT the discriminator: the current native-storage demo exports
 * `PI_DEMO_CONTROL_SOCKET` as well, so condemning a setting merely because a marker is present would discard an
 * operator's intentional storage choice whenever they launched from inside a demo session.
 */
const OLD_DEMO_TRANSIENT_SESSION_DIR = /^\/proc\/(?:\d+|self)\/fd\/\d+\//u;

/**
 * What to do about an inherited `PI_CODING_AGENT_SESSION_DIR`.
 *
 * Pi owns storage and selects its own session directory, so this contributes nothing of its own. It answers one
 * question: does an inherited value survive into the owner's environment?
 *
 * **The caller must delete the key before applying `env`.** An empty `env` means "no override", and spreading
 * nothing over an inherited copy removes nothing — that was a real defect, where a "dropped" ancestor value stayed
 * selected because real mode copied the environment separately.
 *
 * @param {Record<string, string | undefined>} inherited
 * @returns {{ env: Record<string, string>, decision: "absent" | "preserved-operator-setting" | "dropped-old-demo-transient" }}
 */
export function sessionDirectoryDecision(inherited) {
  const value = inherited?.PI_CODING_AGENT_SESSION_DIR;
  if (typeof value !== "string" || value === "") return { env: {}, decision: "absent" };
  if (OLD_DEMO_TRANSIENT_SESSION_DIR.test(value)) return { env: {}, decision: "dropped-old-demo-transient" };
  return { env: { PI_CODING_AGENT_SESSION_DIR: value }, decision: "preserved-operator-setting" };
}

export function ownerLaunchPlan(options) {
  const {
    mode,
    preload,
    extension,
    bundledCli,
    tuiPackageRoot,
    profile,
    cols,
    rows,
    owned,
    token,
    bridgeToken,
    sidebandSocketEnv,
    sidebandTokenEnv,
    fakeProviderId,
    fakeModelId,
  } = options;
  if (mode !== "fake" && mode !== "real") throw new Error(`unknown owner mode ${JSON.stringify(mode)}`);
  if (options.requestedName !== undefined && !isNativeSessionName(options.requestedName)) throw new Error("Invalid native session name");
  const nameArgs = options.requestedName === undefined ? [] : ["--name", options.requestedName];

  // Set in both modes: this owner's own channel, geometry and the terminal Pi negotiated against.
  const ownPlumbing = {
    TERM: profile.term,
    COLUMNS: String(cols),
    LINES: String(rows),
    // Pi owns storage. It selects its own session directory from its own configuration, so this demo sets no
    // session-directory override at all and records whatever path Pi reports.
    //
    // Pi owns storage and picks its own session directory, so nothing about it belongs in this SHARED plumbing.
    // It used to live here, which meant an operator's inherited value was spread into FAKE mode as well and a
    // disposable fake launch could write into operator history. The decision is now applied by real mode alone.
    PI_NATIVE_BOOTSTRAP_SOCKET: owned.bootstrapSocket,
    [sidebandSocketEnv]: owned.sidebandSocket,
    [sidebandTokenEnv]: bridgeToken,
    PI_DEMO_TUI_PACKAGE: tuiPackageRoot,
    PI_DEMO_CONTROL_SOCKET: owned.controlSocket,
    PI_DEMO_TOKEN: token,
    PI_DEMO_PROFILE: JSON.stringify({ ...profile }),
    PI_DEMO_LOG: owned.ingressLog,
    // The dashboard session this Pi is, so `pi-agents send` run from its tools names the right sender. Always set
    // or cleared here: a session launched from inside another must not inherit its parent's identity.
    PI_AGENTS_SESSION_ID: typeof options.sessionId === "string" ? options.sessionId : "",
    // This release loads its own session-color, so an operator's global copy of it steps aside.
    PI_AGENTS_BUNDLES_SESSION_COLOR: "1",
    // Present only when the launch carried a task. Absent means "open an empty session", which is what
    // the bare `start` command still does.
    ...(typeof options.initialPromptFile === "string" && options.initialPromptFile !== ""
      ? { PI_DEMO_INITIAL_PROMPT_FILE: options.initialPromptFile }
      : {}),
  };

  if (mode === "fake") {
    return {
      // A replaced environment, not an augmented one, and this is the whole list. No API key, no operator
      // HOME, no operator config directory, no real session store.
      env: {
        PATH: "/usr/bin:/bin",
        // A REAL private Pi configuration directory when the caller supplied one, so Pi's own storage convention
        // lands on a path that outlives this manager. The legacy fallback is the runtime root's held-descriptor
        // alias, which is fine for a throwaway session but is not resolvable once this manager exits.
        HOME: typeof options.piConfigHome === "string" && options.piConfigHome !== "" ? options.piConfigHome : owned.home,
        LANG: "C.UTF-8",
        PI_CODING_AGENT_DIR: typeof options.piConfigHome === "string" && options.piConfigHome !== ""
          ? path.join(options.piConfigHome, ".pi")
          : owned.agent,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        JITI_FS_CACHE: "false",
        // The extension registers the labelled fake provider only when fake mode asked for it. Real mode
        // leaves this unset, so the same extension adds the return gesture without touching model selection.
        PI_DEMO_FAKE_PROVIDER: "1",
        // Fixture-only: how long the fake provider holds a turn open, so a test can observe WORKING at all.
        ...(typeof options.inheritedEnv?.PI_DEMO_FAKE_DELAY_MS === "string"
          ? { PI_DEMO_FAKE_DELAY_MS: options.inheritedEnv.PI_DEMO_FAKE_DELAY_MS }
          : (typeof process.env.PI_DEMO_FAKE_DELAY_MS === "string" ? { PI_DEMO_FAKE_DELAY_MS: process.env.PI_DEMO_FAKE_DELAY_MS } : {})),
        ...ownPlumbing,
      },
      args: [
        "--import",
        preload,
        bundledCli,
        ...nameArgs,
        "--tui-mode",
        "regular",
        // The operator's extensions are not loaded in a test: only this demo's own.
        "--no-extensions",
        "-e",
        extension,
        // The requested provider and model when the composer chose one, and the labelled fake otherwise. Fake
        // mode registers both fixture identities, so a selection is honoured rather than pinned.
        "--provider",
        options.requestedProvider ?? fakeProviderId,
        "--model",
        options.requestedModel ?? fakeModelId,
        // The fake provider answers text only. Tool execution is not part of what fake mode shows.
        "-nt",
      ],
      cwd: options.cwd ?? owned.project,
      describesProvider: { label: `${fakeProviderId}/${fakeModelId} (FAKE: deterministic, no model is called)`, isFake: true },
    };
  }

  const inherited = { ...(options.inheritedEnv ?? process.env) };
  for (const key of OWNER_PRIVATE_ENV_KEYS) delete inherited[key];
  // Pi owns storage, so the session directory is decided here and the inherited copy must not smuggle one back.
  // Deleting first is what makes "no override" actually mean no override: spreading an empty object over a copy
  // that still holds the key removes nothing, which is how an ancestor's transient directory used to survive.
  const storage = sessionDirectoryDecision(options.inheritedEnv ?? process.env);
  delete inherited.PI_CODING_AGENT_SESSION_DIR;
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value === "string") env[key] = value;
  }

  return {
    // The operator's environment, minus this demo's own private plumbing, plus this owner's. Their PATH,
    // HOME, config directory and credentials are left exactly as they are: Pi resolves its own configuration,
    // and nothing here reads, copies or rewrites a credential. The storage decision is applied LAST and only
    // here, so an operator's own session directory survives and an old-demo transient one does not.
    env: { ...env, ...ownPlumbing, ...storage.env },
    args: [
      "--import",
      preload,
      bundledCli,
      ...nameArgs,
      "--tui-mode",
      "regular",
      // Their own extensions load normally. This demo's extension is added, not substituted: it supplies the
      // return gesture and the management bridge, and in this mode it registers no provider.
      "-e",
      extension,
      // A provider and model only when the composer chose them. With neither, Pi makes its normal selection
      // and keeps its normal tools; if that selection is unavailable, Pi's own error is what the operator sees.
      ...(typeof options.requestedProvider === "string" && options.requestedProvider !== ""
        && typeof options.requestedModel === "string" && options.requestedModel !== ""
        ? ["--provider", options.requestedProvider, "--model", options.requestedModel]
        : []),
    ],
    cwd: options.cwd ?? owned.project,
    describesProvider: { label: "resolved by Pi from the operator's own configuration", isFake: false },
  };
}
