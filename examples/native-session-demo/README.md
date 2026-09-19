# native-session-demo

One persistent native Pi. Attach from as many terminals as you like, detach them all, come back, and the
session is still there — same process, same draft, same screen.

This is a **development-only integration demo**. It ships in no tarball, it is not a product entry point, it
registers a **labelled fake provider** that calls no model and needs no credential, and it makes no claim to
be qualified. The owner pseudo-terminal mechanism underneath it has had its functional findings corrected, but
its remaining verdict still blocks **redistribution** — see
[The mechanism underneath: corrected, still not publishable](#the-mechanism-underneath-corrected-still-not-publishable).
Read [Honest limits](#honest-limits) before drawing a conclusion from any of it.

## What it actually is

Pi is the whole product here. It owns the editor, the draft, the transcript, the key classification and every
byte on the screen. The manager in [manager.mjs](manager.mjs) owns exactly three things Pi cannot own for
itself:

| The manager owns | Through |
| --- | --- |
| the pseudo-terminal the one real Pi runs on | [`runtime/pty-mechanism.mjs`](../../runtime/pty-mechanism.mjs) |
| which client a byte span came from | seam B: `ProcessTerminal.dispatchNativeInput`, under an attachment epoch |
| when a cold client is repainted | seam E: the core bootstrap sideband's `present` command |

There is no second editor, no second viewer, no key parser, no screen model, no captured byte tail and no
inference from rendered output. A reattachment is a **cold presentation**: Pi renders one complete frame from
its own live component tree. Nothing is replayed.

| File | What it is |
| --- | --- |
| [demo.mjs](demo.mjs) | the command line: `start`, `attach`, `detach`, `status`, `stop`, `serve` |
| [manager.mjs](manager.mjs) | the owner manager: one pseudo-terminal, one control socket, one sideband |
| [client.mjs](client.mjs) | one attachment: raw bytes out, Pi's bytes in, and its own terminal modes restored |
| [owner-preload.mjs](owner-preload.mjs) | the pre-TUI caller inside Pi: it registers the launch-fixed profile and dispatches labelled input |
| [owner-extension.ts](owner-extension.ts) | the Pi extension: the fake provider, and the public `TUI` handover |
| [fake-provider.mjs](fake-provider.mjs) | deterministic replies, computed from the prompt, with no network |
| [protocol.mjs](protocol.mjs) | one bounded frame format shared by all three peers |
| [pending-input.mjs](pending-input.mjs) | the bounded queue for bytes sent before Pi's labelled ingress was ready |
| [pausing-relay.mjs](pausing-relay.mjs) | one direction of the frontend's relay, pausing its source when a `write()` says no |
| [smoke.mjs](smoke.mjs) | the acceptance smoke, driven entirely through the commands above |
| [native-session-demo.test.mjs](native-session-demo.test.mjs) | focused cases; the smoke runs only under `PI_NATIVE_DEMO_SMOKE=1` |

## Run it

Node must be 22.19 or newer and below 23; this repository's pixi environment supplies one. Everything below is
copy-pasteable from the repository root.

```bash
NODE=/mnt/main0/home/gjohnson/projects/pi-agents-native-owner-pty-20260918/.pixi/envs/default/bin/node
DEMO=/mnt/main0/home/gjohnson/projects/pi-agents-native-demo-20260919/examples/native-session-demo/demo.mjs
```

### 1. Start one owner

```bash
$NODE $DEMO start --root /tmp/pi-nsd-mine --cols 100 --rows 30
```

`--root` must not exist. The manager creates it exclusively, `0700`, and owns it: it never adopts a directory it
did not create, never chmods or writes into one, and never recovers or resets one. A leftover root from an
earlier owner is refused by name — stop that owner, remove the directory yourself, or pass another `--root`.

It prints the owner's real identity and the exact commands for the rest:

```
owner pid 1437362, startIdentity 1488117543, process group 1437362
manager pid 1437351, log /tmp/pi-nsd-mine/manager.log
root /tmp/pi-nsd-mine, control socket /tmp/pi-nsd-mine/s
geometry 100x30, provider native-session-demo-fake/deterministic-echo (FAKE: deterministic, no model is called)
cohort .../consumer/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
```

`start` returns when Pi has recorded **`native-mounted`** — the phase at which a key reaches the editor and a
frame reaches the terminal. It does not wait for first paint or for initialization, so a blocking startup
dialog cannot hold your attach command.

Which Pi runs is chosen by manifest, not by whatever npm happens to have installed:

```bash
$NODE $DEMO start --root /tmp/pi-nsd-mine \
  --manifest /mnt/main0/home/gjohnson/projects/pi-agents-tool-error-summary/.superpowers/sdd/2026-09-17-native-attachment/merge-tree-wave-6/partial-integration/selected-artifacts-manifest.json
```

### 2. Attach, from one terminal or several

```bash
$NODE $DEMO attach --root /tmp/pi-nsd-mine --id client-1     # in your first terminal
$NODE $DEMO attach --root /tmp/pi-nsd-mine --id client-2     # in a second terminal
```

Both terminals show the same Pi. Type in either one: it is one shared draft and one shared screen, because
there is only one editor and it is Pi's. Make your terminals 100x30, or start the owner with `--cols`/`--rows`
matching them — there is one shared geometry and no per-client resize.

### 3. Detach, and come back

There is deliberately **no detach key**. This demo adds no key parser, and the default Pi editor owns the
return key, so Pi never offers it to a host. Detach is explicit:

```bash
$NODE $DEMO detach --root /tmp/pi-nsd-mine                   # every attachment
$NODE $DEMO detach --root /tmp/pi-nsd-mine --id client-2     # just that one
```

or send the attach process a signal (`kill -TERM <its pid>`), which detaches it and restores that terminal.

The owner keeps running with zero clients attached — same PID, same start identity:

```bash
$NODE $DEMO status --root /tmp/pi-nsd-mine | grep -E 'ownerAliveWithZeroClients|"pid"|startIdentity'
```

`ownerAliveWithZeroClients` means no reap has been published for the owner and no client is attached. The
mechanism's `reapIfExited()` is a published cache, so `null` is not proof of life on its own; the smoke
corroborates liveness by re-reading the owner's `/proc` identity and comparing its start identity.

Attach again with the same `--id` and it is a new epoch of that attachment. Pi repaints it cold, and the draft
you never sent is still on the screen, because it never left Pi.

### 4. Send something

Type a message and press Enter. The fake provider answers deterministically:

```
DEMO-FAKE-REPLY e86a3df10130 :: unsent draft from client one and an edit from client two
```

The digest is a hash of your own prompt. No model was called; no credential exists in that process.

### 5. Stop

```bash
$NODE $DEMO stop --root /tmp/pi-nsd-mine                     # add --keep-root to keep the logs
```

`stop` detaches every client, dispatches Pi's own end-of-input as the graceful gesture, and escalates only
through this repository's verified group stop, which re-reads PID, start identity and process group
immediately before every signal. It prints the owner's real `wait(2)` status, and `waitObserved` says whether
that status was actually observed: a teardown that timed out without one is reported as unverified rather than
graceful, and its diagnostics are kept.

What it removes is the root **this owner created**, verified against the ownership marker written at creation:

- `--keep-root` keeps the root and its logs, and says so in `rootRemoval.reason`
- a root that was replaced after this owner created it is preserved, not deleted, and the reason is printed
- nothing outside that root is touched, and no directory this demo did not create is ever removed

### Watch the manager instead of backgrounding it

```bash
$NODE $DEMO serve --root /tmp/pi-nsd-mine                    # what `start` runs, in the foreground
```

## Isolation

Every launch is disposable, and the native spawn **replaces** the inherited environment rather than adding to
it — measured, not assumed. The owner's whole environment is the list in `manager.mjs`:

- `HOME`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` all point inside `--root`, created `0700`
- no `*_API_KEY`, no auth file, no operator `~/.pi`, and `--no-extensions` so nothing of yours is discovered
- `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1`
- tools are disabled (`-nt`): this demo shows attachment, not tool execution
- **the control socket is token-authenticated**: every client, control and in-Pi ingress connection must present
  the token in its first frame, and nothing is forwarded before it is accepted with a constant-time comparison.
  The token lives in `<root>/token` (`0600`), never in `argv` and never in a log
- **the seam E sideband is not token-authenticated, and is not described as if it were.** It is Pi's own
  unchanged core bootstrap protocol 1, which carries no credential field; this demo adds none and invents no
  core protocol field. Its only protection is that it is a unix-domain socket in a `0700` directory owned by
  the operator who started the owner
- both sockets are unix-domain and `0600`, in that `0700` directory. There is no TCP listener
- frames are bounded (256 KiB), a client that falls 4 MiB behind is disconnected **by name** rather than
  silently dropped, and bytes sent before Pi's labelled ingress is ready are held in order and delivered once —
  up to 64 KiB, decided **before** a span is held: a span that would cross the bound is refused and its
  attachment is detached by name, so it is never delivered later and reconnecting cannot grow that queue
- the frontend respects backpressure in both directions. A `write()` that answers `false` has already accepted
  that chunk, so nothing is re-sent; the other side of that direction is paused and resumed on one drain, which
  is how a slow terminal becomes visible to the manager's 4 MiB bound instead of hiding in a private queue

## Prove it

```bash
# focused cases, no Pi, under a second
$NODE node_modules/vitest/vitest.mjs run examples/native-session-demo/native-session-demo.test.mjs --no-cache

# the real user flow: two clients, two real pseudo-terminals, one real bundled CLI
$NODE examples/native-session-demo/smoke.mjs --root /tmp/pi-nsd-smoke --evidence /tmp/nsd-evidence
```

The smoke drives only the commands above. It types an unsent draft from the first attachment, detaches
everything, checks the owner's identity is unchanged and unreaped, reattaches, asserts the retained draft came
back on Pi's own repaint, attaches a second client to the same draft, edits from there, submits, and reads the
deterministic reply on both screens. It writes each client's terminal transcript, the manager log, the
in-Pi caller's JSONL and measured timings into `--evidence`.

It passes only when the stop is verified as well: the original owner demonstrably gone (`ENOENT`/`ESRCH` from
procfs, or a PID now carrying another start identity) **and** an actual raw `wait(2)` status with an exit code
or a terminating signal. An inspection that cannot answer — a permission error, malformed proc data, an
ambiguous identity — is uncertainty, and uncertainty fails. A failing run writes `smoke-failure.json`, attempts
this demo's own `stop`, and signals only the processes it spawned itself, each re-verified by PID, start
identity and process group first.

Evidence recorded before this correction (the `merge-tree-wave-7/native-demo` run) is still a real happy path,
but it was collected when the standalone smoke's `passed` was unconditional: it proves the user flow it
recorded, not that a stop was verified. Only runs from this correction onward carry the conjunction above.

## Honest limits

- **Not qualified.** This is one integration demo against one patched, unreleased cohort. It is not seam
  qualification, not a Gate 5 pass, and not a substitute for the seam work it exercises.
- **Seam A is not activated.** No native submission host is registered, so the submission barrier, its
  one-use fences and its retain-submit-commit draft order are not exercised here. Submission behaves as
  unmanaged Pi's.
- **Seam C authorization is never consulted.** Pi asks a host about a return key only when the focused
  component declares it free, and the default editor declares nothing, so it owns the key. That is why detach
  is the manager's explicit command; this demo does not add a key parser to work around it.
- **Seam F response authorization is registered but unexercised by the smoke.** The pseudo-terminals the smoke
  drives answer no capability query. A real terminal emulator would reply, and the host refuses to apply it,
  because the profile is fixed by the owner at launch.
- **Seam G is opted into but not demonstrated.** No external editor is launched, so no drain boundary, phase
  announcement or `handoff-closed` refusal appears in the smoke.
- **No ledger, no canonical ownership, no recovery.** The manager holds one owner for as long as it runs. It
  is not a durable ledger, it is not a second canonical writer, and it recovers nothing: if the manager dies,
  the pseudo-terminal closes and the owner is hung up. A root left behind by a dead manager is refused by the
  next `start`, not adopted, reset or cleaned up for you.
- **Output produced while detached is not retained.** It is read and discarded, which is why a reattachment is
  a repaint rather than a replay.
- **One geometry, fixed at launch.** A client whose terminal differs is told so and attaches anyway. There is
  no per-client viewport, and no controller or observer role.
- **Linux, x86-64, glibc.** That is what the owner pseudo-terminal artifact supports; it refuses other hosts
  by name.

## The mechanism underneath: corrected, still not publishable

The owner pseudo-terminal this demo runs on is `runtime/pty-mechanism.mjs` and the committed artifact in
`vendor/pty/`, merged into this tree from commit `a08bfca` — the reviewed correction of `715e59e`. Its scoped
re-review resolved both functional P1 findings this demo previously inherited. What remains is a **release
blocker**, not a functional one.

| Finding | Where it stands |
| --- | --- |
| **Spawned identity could race the native reaper and PID reuse.** | **Resolved in `a08bfca`.** The native patch reads `/proc/<pid>/stat` before the sole waiting thread starts, and every initial identity, session and terminal field this demo records comes from that birth snapshot. Later foreground-group reads compare start identity and refuse a changed one. `stop` still prefers Pi's own end-of-input and the reaper's `wait()` status, and escalates only through the repository's verified group stop. |
| **A partial PTY write reported its accepted byte count only in error text.** | **Resolved in `a08bfca`.** The error now carries numeric `bytesWritten`/`totalBytes`. `handle.write` is still used in exactly one place, `smoke.mjs`, and it still does not retry: it types spans a terminal accepts whole, so a partial write fails the smoke loudly. The failure reports those two counts **as numbers read from the error**, never parsed from its message. |
| **`reapIfExited()` is a published cache.** | Documented in the mechanism: `null` is not proof of life. This demo's `ownerAliveWithZeroClients` is read that way, and the smoke proves liveness with a `/proc` identity comparison instead. |
| **`@replit/ruspty@3.7.1` declares MIT but supplies no authoritative license notice.** | **Open, and release-only.** It blocks redistribution and package qualification of the native artifact. It does not block this private, unpublished demo. Nothing here authorizes publication or live activation, and the demo ships in no tarball. |
| **The generated provenance description understates its input groups.** | Open, non-blocking, and not this demo's to fix. Noted so nobody reads the notices file as complete provenance. |

So: the functional doubt this demo used to carry is gone, and what is left is a licensing gap that stops the
mechanism from being shipped — not from being run here, in place, by the person who built it. The commands
above run end to end and the recorded evidence is real; none of it is a release qualification.
