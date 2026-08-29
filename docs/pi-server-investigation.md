# Pi server investigation

## Recommendation: stay put and revisit when Pi ships a documented server

Do not replace the `pi-agents` runtime with the installed Pi server code. Version 0.84.3 ships an experimental command parser, client library, and protocol, but the installed `pi` executable does not route to the parser. I found no supported command that starts the server. The apparent `shared` and `exclusive` lease modes arbitrate leases inside one `PiClient` object. They are not sent over the wire, so they do not establish one writer across separate clients.

The client is also a structured data client, not a remote copy of Pi's terminal interface. It receives snapshots, normalized transcript items, and progress events. It does not receive Pi's terminal rendering, extension footer factories, widgets as native components, or custom terminal components. Adopting it would retain the hardest part of the current viewer work while adding an undocumented, experimental dependency.

A narrower hybrid is not justified in 0.84.3 because there is no executable server to host sessions. Keep the current launcher, list, daemon, workers, ownership checks, command journal, and viewer path. Revisit this decision when all four conditions hold:

1. `pi --help` documents a server and client invocation, and the installed executable starts them.
2. Pi documents cross-connection ownership, disconnect cleanup, server restart, and session recovery.
3. The server and client are available through supported package exports or the executable, with a compatibility policy.
4. A supported client can either render native interactive Pi or expose every extension user-interface primitive needed to reproduce it.

Changing the recommendation then would require a temporary-root migration rehearsal, protocol compatibility tests, and an operator maintenance window. Existing live sessions cannot be transferred into a new server process in place based on the installed source. A migration would leave current workers running until idle, start new sessions under the new host, and retire the old runtime only after those sessions stop. **Unverified:** Pi may add an import or restart facility in a later release. Version 0.84.3 does not provide evidence for one.

This finding does not require edits to `docs/architecture-plan.md` or `docs/architecture-review.md`. It rejects replacing the current runtime with Pi's installed experimental code. The separate pseudo-terminal option near the end would change the viewer portion of the plan if selected, so that decision should precede viewer-specific implementation work.

## Evidence scope

All installed-package paths below are relative to:

```text
/mnt/main0/home/gjohnson/.pixi/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent
```

I read the shipped JavaScript, declarations, package manifests, and package documentation. I also made bounded command probes with standard input closed and `HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` under a fresh `mktemp` directory. The probes did not use the operator's session or state directories.

## 1. Version 0.84.3 does not expose a working server command

The installed package version is 0.84.3:

```json
"version": "0.84.3"
```

Source: `package.json:3`.

The orphaned experimental parser describes the expected syntax:

```js
const listenOption = transportOption("--listen");
export const serverCommand = new Command("server")
    .option(listenOption)
...
    .action((command, context) => context.runServer(command));
```

Source: `dist/cli/experimental/commands/server.js:3-5,24`.

It accepts only canonical absolute Unix addresses. The address parser rejects protocols other than `unix:` and requires `unix:///...`:

```js
if (url.protocol !== "unix:") {
    return { error: `Unsupported ${option} transport "${url.protocol}"` };
}
...
if (!value.startsWith("unix:///") ||
```

Source: `dist/cli/experimental/transport-address.js:10-12,15-16`.

That makes the parser's nominal command:

```text
pi server --listen unix:///absolute/path/to/pi.sock
```

It is not a working command in this installation. The package's executable is `dist/bundle/cli.js` (`package.json:9-11`). The normal unbundled entry point calls `main(process.argv.slice(2))` and does not import `experimentalCli` (`dist/cli.js:18`). The experimental parser exists separately and composes `server` and `client` subcommands:

```js
export const experimentalCli = piCommand.command(serverCommand).command(clientCommand);
```

Source: `dist/cli/experimental/cli.js:4`.

The bounded probe ran the nominal command with temporary state. It exited with:

```text
Error: Unknown option: --listen
```

Setting `PI_EXPERIMENTAL=1` produced the same result. Both probes exited with status 1. These probes do not establish any working server invocation.

**Answer:** no supported or working exact server command exists in the installed package. The nominal parser syntax above is unreachable through the installed `pi` executable. I also found no standalone server executable. Calling the parser module directly would still require an application-supplied `context.runServer` implementation, and the package export map does not expose that module.

## 2. The client receives structured state, not native interactive rendering

The protocol is closer to the remote procedure call mode already consumed by `pi-agents` than to tmux. Its session snapshot contains phase, model, thinking level, attachment flags, a normalized transcript, queued steering messages, and a revision:

```ts
readonly phase: ...;
readonly model: ...;
readonly thinkingLevel: ...;
readonly attached: Type.TBoolean;
readonly locked: Type.TBoolean;
readonly revision: Type.TInteger;
readonly transcript: Type.TArray<...>;
```

Source: `node_modules/@earendil-works/pi-protocol/dist/schemas.d.ts:1390-1405`.

The event union consists of four structured event types:

```ts
"server_snapshot"
"session_snapshot"
"session_progress"
"session_removed"
```

Source: `node_modules/@earendil-works/pi-protocol/dist/schemas.d.ts:6174-6176,6208-6210,6509-6512,7237-7239`.

The protocol documentation says snapshots are authoritative and progress events are transient user-interface hints:

> Session and server snapshots are authoritative. Progress events are transient UI hints and must not be reduced into authoritative state.

Source: `node_modules/@earendil-works/pi-protocol/README.md:9`.

The coding-agent adapter reconstructs a transcript from these objects. It applies `session_progress` to its own transcript state and notifies listeners:

```js
if (event.type !== "session_progress" || !this.#transcript)
    return;
this.#transcript = applyTranscriptProgress(this.#transcript, event.progress);
this.#notify();
```

Source: `dist/client/remote-session.js:281-284`.

The low-level lease exposes commands and state callbacks, not terminal bytes:

```js
subscribe(listener) { ... }
onEvent(listener) { ... }
async prompt(text) { ... }
async steer(text) { ... }
async abort() { ... }
async setModel(model) { ... }
async setThinking(thinkingLevel) { ... }
```

Source: `node_modules/@earendil-works/pi-client/dist/session-handle.js:17-46`.

No protocol field carries terminal escape sequences, screen cells, component trees, footer factories, arbitrary widgets, or terminal resize events. The public coding-agent root exports `InteractiveMode`, but that is the local interactive implementation, not a remote renderer (`dist/index.js:35`). The public `./client` subpath exports `RemoteSession` and transcript reducers, not `InteractiveMode` (`dist/client/index.js:1-3`).

**Answer:** a client receives a structured snapshot and event stream. It must render its own interface. It does not drive native interactive Pi, so the session view cannot be indistinguishable from native Pi merely by adopting this client. Extension-specific rendering is especially incomplete because the four-event protocol has no generic custom-component or footer event.

## 3. Lease modes do not arbitrate separate clients

The lease wording is easy to misread. `PiClient.acquireSession()` reserves a lease in local maps before it sends any attach request:

```js
async acquireSession(sessionId, options) {
    this.#assertNotDisposed();
    const token = this.#reserveSessionLease(sessionId, options.mode);
```

Source: `node_modules/@earendil-works/pi-client/dist/client.js:94-97`.

The local reservation enforces these rules within one `PiClient` object:

```js
if (mode === "exclusive" && count > 0) {
    throw new PiSessionOwnershipError(...);
}
if (mode === "shared" && this.#exclusiveSessionLeases.has(sessionId)) {
    throw new PiSessionOwnershipError(...);
}
```

Source: `node_modules/@earendil-works/pi-client/dist/client.js:330-338`.

It refuses immediately. It does not demote or queue the new lease. Several shared leases can coexist in that one client object. Every lease, including a shared lease, exposes `prompt`, `steer`, `abort`, `setModel`, and `setThinking` (`node_modules/@earendil-works/pi-client/dist/session-handle.js:32-46`). Shared therefore means shared local access, not read-only observation.

Most important, the wire attach request omits the mode:

```js
await this.#request({ command: "attach", sessionId });
```

Source: `node_modules/@earendil-works/pi-client/dist/client.js:125-129`.

The protocol schema confirms that `attach` carries only `command` and `sessionId` (`node_modules/@earendil-works/pi-protocol/dist/schemas.d.ts:1744-1747`). A server cannot distinguish a shared acquisition from an exclusive acquisition from this message. Separate `PiClient` instances have separate lease maps, so these modes cannot enforce one writer across processes or connections.

The snapshot has `attached` and `locked` booleans, and the error vocabulary includes `session_locked` (`node_modules/@earendil-works/pi-protocol/dist/schemas.d.ts:1402-1403,1723-1726`). The installed source does not document who sets `locked`, whether a second connection's attach is refused, or whether commands from two attached connections are accepted. The server implementation needed to settle those questions is not exposed or runnable here. I will not infer behavior from field names.

On disconnect, the client clears attachment state and invalidates every local lease:

```js
if (change.state === "disconnected") {
    this.#state.clearAttachments();
    this.#invalidateAllSessionLeases();
```

Source: `node_modules/@earendil-works/pi-client/dist/client.js:273-276`.

The client does not reconnect automatically. Its documentation requires an explicit `reconnect()` call (`node_modules/@earendil-works/pi-client/README.md:28`). There is no lease-taken, lease-lost, writer-present, promotion, or demotion event in the four-event server union.

**Answer:** `exclusive` refuses a conflicting lease immediately, `shared` allows several command-capable leases, and neither mode crosses a `PiClient` boundary. What a second process observes and how server-side cleanup works after a client dies are unclear from the installed source because the wire carries no lease mode and the executable server is absent.

## 4. Server-owned session lifetime is not implemented in a reachable runtime

The protocol separates durable session metadata from acquired runtime state. Its documentation says the list exposes durable metadata and runtime state appears only after acquisition (`node_modules/@earendil-works/pi-protocol/README.md:11`). That is an interface distinction, not evidence of a process-lifetime policy.

The low-level client detaches on its final local lease release:

```js
if (count <= 1) {
    const detachment = this.#request({ command: "detach", sessionId }).then(() => undefined);
```

Source: `node_modules/@earendil-works/pi-client/dist/client.js:186-190`.

A transport disconnect instead invalidates local leases without sending that detach request (`node_modules/@earendil-works/pi-client/dist/client.js:273-276`). The behavior after that boundary belongs to the missing server implementation.

**Unclear from installed source:** whether an active turn continues after detach, whether an idle runtime remains loaded, whether a disconnected connection is cleaned up immediately, and whether a server shutdown terminates active turns cleanly.

**Supported conclusion:** sessions cannot survive the server process as active in-memory runtimes. Any later process could at most reopen durable session files. I found no server restart journal, runtime adoption handshake, process identity record, or reattachment token. **Unverified:** a future or omitted server implementation may reopen session files after restart. Version 0.84.3 provides no runnable path or documented recovery contract.

## 5. The installed code makes none of the current runtime safely redundant

| `pi-agents` part | Coverage in installed Pi 0.84.3 | Evidence and consequence |
|---|---|---|
| Daemon | Does not cover | No reachable Pi server command exists. The protocol and client libraries do not own a running process. |
| Worker supervisor | Does not cover | No reachable server runtime starts or adopts per-session Pi work. There is no shipped process identity or recovery contract. |
| Ownership leases | Partly covers inside one object only | Local `shared` and `exclusive` maps reject conflicting leases in one `PiClient`. Mode is absent from the wire, so cross-client writer ownership remains ours. |
| Process identity checks | Does not cover | The client protocol identifies sessions, not operating-system process ID, start identity, process group, or signal target. |
| Command journal | Does not cover | Requests have correlation IDs, but the client stores pending requests only in memory. On disconnect it rejects and clears them (`node_modules/@earendil-works/pi-client/dist/client.js:278-286`). There is no durable accepted, delivered, acknowledged, or ambiguous state. |
| Event store | Partly covers transport delivery only | The server protocol sends snapshots and progress events, and the client keeps current state in memory. The documentation calls progress transient. There is no durable cursor, replay contract, or restart continuity. |
| Viewer normalizer | Partly covers | Pi's protocol already normalizes transcript items and progress. Adopting it could replace some RPC-frame normalization, but extension UI and native terminal components are absent. |
| Viewer store | Does not cover durable dashboard recovery | The client stores snapshots and listeners in memory. `reset()` clears snapshots on reconnect (`node_modules/@earendil-works/pi-client/dist/state.js:16-20`). Canonical Pi session files could rebuild completed transcript state, but live progress and dashboard cursor state are not a durable client store. |

This table is deliberately conservative. A non-runnable parser and a protocol declaration are not substitutes for process supervision.

## 6. A future server adoption would still leave substantial work

At minimum, `pi-agents` would retain launching policy, the session list, and worktree isolation. It would also need:

1. A supported way to start, authenticate, monitor, and upgrade the Pi server.
2. Cross-client writer arbitration or a dashboard-side composer lease, because wire attachments have no lease mode.
3. Dashboard registry fields that Pi does not own, including isolation choice, worktree path, launch failure, summaries, color, and operator-facing lifecycle.
4. Durable command ambiguity handling if the product keeps its current accepted-versus-delivered semantics.
5. A viewer renderer and extension user-interface adapter, because the protocol supplies data rather than native terminal output.
6. Compatibility checks and migration logic for protocol changes, live old clients, and server upgrades.
7. Stop and delete safety around process identity if `pi-agents` can signal or retire server-owned work.
8. Authentication and Unix-socket permissions suitable for local mutation access.

A documented Pi server could remove the per-session worker and much of the raw RPC adapter. It would not automatically remove product metadata, worktree policy, list behavior, command semantics, or terminal rendering.

## 7. Dependency risk is high and conflicts with this repository's import rule

The coding-agent package export map allows only the root, `./rpc-entry`, and `./client` (`package.json:14-27`). It does not export `./dist/cli/experimental/...` or `./server/create-harness`. Node's package export rules therefore reject those package subpaths for normal package imports.

The public `@earendil-works/pi-coding-agent/client` subpath is usable and exports the higher-level `RemoteSession`. It still needs a low-level connected client supplied by the application. The bundled dependency `@earendil-works/pi-client` has public root and `./unix` exports in its own manifest (`node_modules/@earendil-works/pi-client/package.json:8-18`). Depending on that transitive nested copy directly would be fragile unless `pi-agents` declares the package itself. It also would not produce a server.

The `pi` executable alone does not expose the experimental parser. The bounded command probe returned `Unknown option: --listen`, and `pi --help` omits these commands. Deep-importing the parser would violate `AGENTS.md`'s package-root rule and still leave `context.runServer` undefined.

The protocol package labels itself experimental and states that it has no compatibility guarantees:

> All schemas reject unknown object properties. The protocol is experimental and has no compatibility guarantees.

Source: `node_modules/@earendil-works/pi-protocol/README.md:69`.

**Answer:** the client data model is partly reachable through public package exports. The server is not reachable through a public package root or the installed executable. Depending on it today would require unsupported assembly around orphaned experimental files or code that is not shipped here.

## Native Pi rendering is possible with a pseudo-terminal, independently of the server

A pseudo-terminal (PTY) can make the session view native because Pi itself would run in interactive mode and write its real terminal byte stream. The daemon would own the PTY master and child process. A terminal client would attach by forwarding keystrokes to the master and displaying output bytes, much like tmux.

This requires more than replacing pipes with a PTY:

1. Start interactive `pi` with an isolated session path, environment, working directory, and PTY slave.
2. Keep the PTY master in a long-lived daemon or worker so terminal closure does not send end-of-file to Pi.
3. Maintain a terminal screen model and scrollback, or delegate both to tmux. Raw byte replay alone cannot reconstruct the current alternate screen reliably for a late client.
4. Arbitrate one input writer. Observers may receive output, but their input must not reach Pi.
5. Forward signals and terminal modes correctly, including bracketed paste, Kitty or CSI-u keyboard negotiation, mouse input, and clipboard-related sequences.
6. Choose a resize policy and send `TIOCSWINSZ` plus `SIGWINCH`. One PTY has one row and column size, so clients with different sizes cannot each receive a layout tailored to their terminal.
7. Persist enough scrollback for reattach and bound its memory or disk use.
8. Detect child exit and retain the same process identity and safe-stop checks used today.

Pi's installed tmux documentation confirms that Pi already expects terminal multiplexer behavior and documents extended key forwarding (`docs/tmux.md:1-13`). Using tmux as the host would provide mature detach, screen state, resize, and scrollback behavior. It would also add an external process and configuration dependency, and `pi-agents` would need a stable mapping from dashboard session IDs to tmux sessions.

A daemon-owned PTY could delete most of the custom viewer stack:

- raw RPC frame parsing and most of `pi-rpc-adapter` for viewer operations
- viewer normalization
- normalized viewer event persistence and replay
- custom transcript, tool, footer, widget, and extension component rendering
- most dashboard implementations of Pi slash commands

It would not remove launching, the list, worktree isolation, worker or PTY supervision, process identity checks, writer ownership, authentication, or registry state. The command journal could shrink if composer input becomes ordinary terminal bytes, but that changes semantics. A terminal byte write cannot provide the current durable accepted, delivered, and ambiguous command states without an acknowledgment protocol above the PTY.

The costs are concrete:

- **Multi-client behavior:** one writer is straightforward, but observers see the writer's terminal state and dimensions. Independent scrolling needs per-client history views rather than direct attachment to one live screen.
- **Resize:** the active writer usually controls the single PTY size. Every resize redraws Pi for all viewers. Fixed canonical dimensions avoid layout churn but waste space or clip on smaller terminals.
- **Scrollback:** the daemon must emulate a terminal and store logical lines, or use tmux. Capturing output bytes is insufficient because cursor movement and screen clearing mutate prior cells.
- **Control integration:** dashboard actions such as model selection, stop, and UI responses become synthesized keystrokes unless a separate structured control channel remains. Synthesized keystrokes are more brittle than RPC commands.
- **Recovery:** a daemon crash loses a daemon-owned PTY master unless a separate worker or multiplexer owns it. tmux can outlive the dashboard daemon; an in-process PTY cannot.

**Recommendation for native rendering:** treat PTY hosting as a separate product direction, not as a reason to adopt the experimental server. If exact native Pi rendering is the highest priority, a narrow prototype should host one disposable interactive Pi under tmux or a worker-owned PTY and measure attach, resize, scrollback, extension widgets, and writer handoff. Do not combine that experiment with the 18-commit runtime simplification. Choosing PTY rendering would supersede much of the viewer work, while leaving launcher, list, isolation, supervision, and ownership work intact.

## Sources

- Installed `@earendil-works/pi-coding-agent` 0.84.3 package manifest and shipped JavaScript under `/mnt/main0/home/gjohnson/.pixi/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent`.
- Installed `@earendil-works/pi-client` 0.84.3 manifest, README, JavaScript, and declarations under `node_modules/@earendil-works/pi-client` within that package.
- Installed `@earendil-works/pi-protocol` 0.84.3 README and declarations under `node_modules/@earendil-works/pi-protocol` within that package.
- Installed Pi tmux documentation at `docs/tmux.md` within that package.
