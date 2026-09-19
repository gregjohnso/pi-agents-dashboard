# vendor/pty: the pinned native pseudo-terminal artifact

A permanent pseudo-terminal per Pi owner needs three things Node 22 does not provide: a real PTY master file
descriptor **in the host process**, a child that is a session leader with that terminal as its controlling
terminal, and the child's actual `wait(2)` status. This directory is how the project gets them without a
compiler, a download or a lifecycle script on an operator's machine: an exact source pin, one focused patch,
a build-only toolchain, and the built artifact committed and shipped.

`runtime/pty-mechanism.mjs` is the only consumer. Nothing else loads the artifact.

## What was chosen, and what was rejected

The mechanism is [`@replit/ruspty`](https://www.npmjs.com/package/@replit/ruspty) 3.7.1 source, built here with
one patch. Its **public** interface is what this choice rests on: `new Pty({ command, args, envs, dir, size,
onExit })` forks a child that does `setsid` then `ioctl(TIOCSCTTY)`, `takeControllerFd()` transfers ownership
of the master descriptor to the caller, `dropUserFd()` releases the parent's copy of the slave, `pid` is the
owner's, and `ptyResize(fd, size)` is `TIOCSWINSZ`. No private field is read.

Rejected, each for a specific reason measured or read rather than assumed:

| Candidate | Why not |
| --- | --- |
| `node-pty` | `node-gyp rebuild` at install time: a compiler on the operator's machine |
| `@lydell/node-pty` | reports the terminating signal, but the published typings expose no master descriptor, and the library attaches its own reader and writer to the one it holds, so the host cannot own the descriptor without depending on internals |
| `*-prebuilt-multiarch` forks | `prebuild-install` downloads a binary during `npm install` |
| `@opencode-ai/pty` | an out-of-process service; the descriptor it opens is meaningful only inside that process |
| a helper process of our own | a pty master cannot be handed to an already running Node host at all: Node has no `SCM_RIGHTS`, and opening `/proc/<pid>/fd/<n>` for a `ptmx` descriptor opens a **new** pty |
| Python or Bun | neither can be assumed installed, and `Bun.Terminal` is not a Node API |

Upstream `@replit/ruspty` as published could not be used unmodified, and the patch is exactly those defects
plus the one fact the host cannot get any other way:

1. **It erased the exit cause.** The reaping thread reported `status.code().unwrap_or(-1)`, so a child killed
   by a signal arrived as `-1` with no signal and no core-dump bit — measured: `SIGTERM` reported as
   `{err: null, code: -1}`. The patch reports the raw `wait(2)` status instead, and stores it in an atomic
   **before** the callback, which is also what makes a synchronous, signal-free `rawWaitStatus()` possible.
   That atomic is a published cache of a completed reap, not a `waitpid`: it is written just after `wait(2)`
   returns, so `null` means "nothing published yet" rather than "the child is alive", and identity is still
   revalidated before anything signals the PID.
2. **It wrote bytes into the terminal.** On exit it injected `ESC ] 7878 ESC \` into the slave so its own
   JavaScript wrapper could detect end-of-output — measured in the output stream of a plain `sh -c 'exit 7'`.
   A terminal this project presents must carry the owner's bytes and nothing else, and filtering the sequence
   back out in a wrapper would also swallow it when a child legitimately emits it. The patch removes the
   write, the sequence and its accessor at the source.
3. **It gave the host no way to name the child it spawned.** The only identity upstream exposes is `pid`, and
   the reaping thread frees that number the moment it reaps: a host reading `/proc/<pid>` afterwards can be
   answered about whatever process holds the number next. The patch reads the child's own `/proc/<pid>/stat`
   once, after `spawn` returned — so after `setsid` and `TIOCSCTTY` — and before the reaping thread starts,
   when no `wait(2)` has run and the PID cannot have been reused, and exposes it as `birthProcStat()`.
   A failed read yields no snapshot rather than a failed spawn, because the reaping thread must start either
   way or the child would be left unreaped.

The patch adds no behaviour of its own: no sandbox use, no cgroup use, no new option. Upstream's JavaScript
(`index.js`, `wrapper.ts`, `dist/`, `syntheticEof.ts`) is neither built, shipped nor used — `build.mjs` builds
the Rust crate only, and `runtime/pty-mechanism.mjs` loads the artifact directly.

## Platform assumptions, stated rather than implied

The artifact is `pi-agents-owner-pty-linux-x64-gnu.node`: **Linux, x86-64, glibc**. It is a Node-API version 4
addon, so it is ABI-stable across Node majors, but it links the build host's glibc, `libgcc_s` and `libm`
(`build-manifest.json` records the exact versions and the linked sonames). There is no musl artifact, no
arm64 artifact and no non-Linux artifact; `runtime/pty-mechanism.mjs` refuses those hosts by name instead of
loading a binary that cannot work.

## What is here

| File | What it is |
| --- | --- |
| `upstream-lock.json` | the pin: package, version, tarball URL, integrity, digests of the files the patch touches, the licence statement, and the build plan |
| `patches/0001-*.patch` | the focused source diff, applied with no fuzz |
| `build.mjs` | verify, extract, patch, build, record; nothing is resolved at build time |
| `pixi.toml`, `pixi.lock` | the build-only Rust toolchain, separate from the application environment |
| `Cargo.lock` | the resolved crate set the committed artifact was built from; later builds are held to it with `--locked` |
| `build-manifest.json` | what the committed artifact is: digest, size, toolchain, glibc, linked libraries |
| `third-party-notices.mjs` | generates the two files below from the build's `cargo tree`, `Cargo.lock`, cargo's registry cache and `upstream-notices/`; `--check` fails if they are not what those inputs produce |
| `THIRD-PARTY-NOTICES.md`, `third-party-inventory.json` | the inventory of every crate compiled into the artifact, the licence texts their upstreams publish, and the one gap that is a release blocker |
| `upstream-notices/` | licence texts retrieved by hand from the exact VCS commit a crate was published from, for crates whose published package contains none; held by digest, with the URL and date recorded |
| `pi-agents-owner-pty-linux-x64-gnu.node` | the shipped artifact |

## Rebuilding

Only on a build worker, and only when the pin, the patch or the toolchain changes:

```bash
env -u PIXI_PROJECT_MANIFEST pixi run --manifest-path ./pixi.toml --frozen node ./vendor/pty/build.mjs
```

It refuses to continue on a tarball whose integrity or digest is not the locked one, on an upstream file the
patch was not written against, or on a patch that does not apply exactly. The artifact and
`build-manifest.json` are then committed together: the shipped binary and the record of what it is are one
change, never two.

## Licensing, and the one release blocker

The artifact is a Rust `cdylib`, so every crate that is not a proc macro — and the Rust standard library — is
compiled into the bytes committed here. `THIRD-PARTY-NOTICES.md` inventories all of them with the licence text
each upstream publishes, and `third-party-inventory.json` is the same record in machine-readable form. Both are
generated by `third-party-notices.mjs` from named inputs and are packed with the artifact:

```bash
node vendor/pty/third-party-notices.mjs --cargo-tree <the build's cargo tree output>
```

**Publishing this package or the artifact is blocked on one unresolved gap.** `@replit/ruspty` declares MIT in
its `package.json` and publishes no licence text anywhere: not in the pinned tarball, not in its `Cargo.toml`,
and not in its repository, whose full contents listing and license API both answer with no licence file. MIT
asks for the copyright notice and permission text to travel with the distribution, and there is no
authoritative text to reproduce; writing a holder and a year upstream never wrote would be a fabricated
notice. `upstream-lock.json` and `THIRD-PARTY-NOTICES.md` record the gap, the sources checked and the exact
HTTP answers. A private, unpublished demo that only runs the artifact locally redistributes nothing and is not
blocked by this; a release is.
