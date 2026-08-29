# AGENTS.md

`pi-agents` is a terminal dashboard that launches and supervises installed Pi sessions. It is deliberately small: Pi runs the agent, this package owns supervision, durable state, and the interface.

## Read before you change anything

- [README.md](README.md) — what the tool does and how an operator uses it.
- [docs/architecture.md](docs/architecture.md) — process roles, how a launch and its events travel, state on disk, and the invariants a change must not break.
- [docs/development.md](docs/development.md) — commands, test layout and rules, code conventions, and the traps that are not derivable from the code.
- [docs/superpowers/specs/](docs/superpowers/specs/) — original design and plan. Historical; where they disagree with the code, the code wins.

## How to work here

**Never touch the operator's live state.** `~/.local/state/pi-agents`, and any older root beside it, is production. Never write to it, and never start, stop, or signal its daemon or Pi workers. Build a throwaway root with `mkdtemp` and pass it explicitly.

**Write the failing test first** and watch it fail for the right reason. Run your focused files, then the full suite, then `pixi run typecheck`, before you commit.

**Verify before you claim.** State what you ran and what it printed. Label anything unverified as unverified. "Should work" is not a result.

**Measure before you optimize**, and report the before and the after with the machine's load, because this box swings between load 5 and 30.

**Change only what the task names.** If a fix needs a second change to be correct, say so and ask; do not widen the diff on your own.

**Say when an instruction is wrong.** These briefs have asserted invariants that could not both hold. Stopping to say so is worth more than a clean-looking implementation of the wrong thing.
