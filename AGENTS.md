# AGENTS.md

`pi-agents` is a terminal dashboard that launches and supervises installed Pi sessions. It is deliberately small: Pi runs the agent, this package owns supervision, durable state, and the interface.

## We clone Claude Code's session model

Claude Code solves this problem for far more users than we have, so it is the reference implementation. When a design question comes up, look at what Claude Code does before inventing an answer.

Where to look, in order:

1. [docs/reference/claude-code-behavior.md](docs/reference/claude-code-behavior.md) records its behavior at implementation precision, tagged by evidence class and pinned to version 2.1.251.
2. The installed build itself, read-only: `claude --help`, and `claude agents|attach|logs|stop|rm --help` for the operator-facing verbs. Live state lives in `~/.claude/daemon.lock`, `~/.claude/daemon/roster.json`, and `~/.claude/daemon/attach-journal`. Never write to any of it and never signal its daemon or workers.
3. The published documentation at <https://docs.claude.com/en/docs/claude-code> for behavior the build does not explain.

Record what you learn in the reference document in your own words. Do not copy Anthropic's documentation, help text, or code into this repository; it is proprietary and this package may be published.

Copy it by default. Diverging needs a hard reason, meaning the alternative loses the operator's work, corrupts durable state, hides a failure from him, or Pi cannot support it. These are not reasons: it is not how we built it, it feels safer, or we already wrote the other version.

Five divergences are deliberate and each has a hard reason. We keep a durable command journal with delivery stages, because terminal writes cannot express them. Our workers survive daemon absence indefinitely rather than a 60-second orphan timeout, because that timeout could end running work. Rows use structured state, never inference from terminal output or Pi's session file, because inference hides failures. `rm` forgets only the dashboard record and never touches Pi's canonical file or a worktree. The viewer reconstructs the session rather than hosting a pseudo-terminal, because Pi exposes no repaint, readiness, or detach channel.

## Read before you change anything

- [README.md](README.md) — what the tool does and how an operator uses it.
- [docs/architecture.md](docs/architecture.md) — process roles, how a launch and its events travel, state on disk, and the invariants a change must not break.
- [docs/development.md](docs/development.md) — commands, test layout and rules, code conventions, and the constraints that are not derivable from the code.
- [docs/architecture-plan.md](docs/architecture-plan.md) — approved future work, 20 commits. It describes what we intend to build, not what exists.
- Closed directions, each rejected with evidence. Read the relevant one before proposing it again: [Pi's experimental server](docs/pi-server-investigation.md), [tmux hosting](docs/tmux-prototype-report.md), [Claude Code's model in full](docs/claude-code-session-model.md).

## How to work here

**Never touch the operator's live state.** The state root under `~/.local/state` is production. Never write to it, and never start, stop, or signal its daemon or Pi workers. Build a throwaway root with `mkdtemp` and pass it explicitly.

**Write the failing test first** and watch it fail for the right reason. Run your focused files, then the full suite, then `pixi run typecheck`, before you commit.

**Verify before you claim.** State what you ran and what it printed. Label anything unverified as unverified. "Should work" is not a result.

**Measure before you optimize**, and report the before and the after with the machine's load, because this box swings between load 5 and 30.

**Change only what the task names.** If a fix needs a second change to be correct, say so and ask; do not widen the diff on your own.

**Say when an instruction is wrong.** A brief can ask for two things that cannot both hold. Stopping to say so is worth more than a clean implementation of the wrong thing.

**Documentation describes what the code does today.** The plan describes what was approved. Never document planned behavior as though it ships, and never implement plan text as though it already exists.

**Nothing crossing a process boundary gets renamed without a version rule.** A running daemon holds old code while spawning workers from new code on disk, so a renamed environment variable, frame type, or path is read by one side and not the other.
