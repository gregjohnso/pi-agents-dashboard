#!/usr/bin/env node
/**
 * Attribution under adversarial native framing, against the real terminal.
 *
 * This runs the selected cohort's own `ProcessTerminal` and `TuiMainScreen` on this process's terminal and
 * drives `terminal.dispatchNativeInput` directly, which is the same entry point the demo's pre-TUI caller
 * uses. So the framing, the origin ledger and the provenance are Pi's real ones, and the interleavings below
 * are the real ones a manager can produce — not a simulation of them.
 *
 * What it substitutes, and says so plainly: the focused component here is a small stand-in for the bundled
 * `CustomEditor`, whose `onExtensionShortcut` hook is coding-agent-internal and cannot be constructed without
 * booting the whole CLI. It recognises the shortcut exactly as that hook does — `matchesKey(data, shortcut)`
 * on the delivered sequence — and calls the same `requestReturn()`. The end-to-end path through the real
 * `CustomEditor` and `pi.registerShortcut` is covered separately, by `list-flow.mjs`.
 *
 * Each case reports which attachment the gesture asked to detach, or the refusal reason, as data. Nothing is
 * asserted here; the driver asserts.
 */

import { createRequire } from "node:module";
import path from "node:path";

import { resolveCohort } from "./cohort.mjs";
import { RETURN_SHORTCUT, clearInputProvenance, noteInputProvenance, provideReturnRequest, requestReturn } from "./return-channel.mjs";

const F9 = "\u001b[20~";

/** One dispatch, labelled exactly as the manager labels a client's span. */
function span(terminal, attachmentId, epoch, bytes, generation = 1) {
  return terminal.dispatchNativeInput({
    attachmentEpoch: { attachmentId, epoch },
    bytes: new Uint8Array(Buffer.from(bytes, "utf8")),
    binding: { generation },
  });
}

async function main() {
  const cohort = resolveCohort({});
  const require = createRequire(path.join(cohort.tuiPackageRoot, "package.json"));
  const tuiModule = await import(`file://${require.resolve(cohort.tuiPackageRoot)}`);
  const { ProcessTerminal, TuiMainScreen, matchesKey } = tuiModule;

  const asked = [];
  provideReturnRequest((origin) => asked.push(origin));

  /** Observed provenance per delivered sequence, so a case can report what Pi said as well as what it decided. */
  const seen = [];
  const outcomes = [];

  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  /**
   * The stand-in for `CustomEditor`. It recognises the shortcut the same way the bundled editor's
   * `onExtensionShortcut` does and calls the same entry point; it inserts nothing and holds no draft.
   */
  const component = {
    focused: true,
    render: () => ["attribution-cases"],
    invalidate: () => {},
    handleInput(data) {
      if (!matchesKey(data, RETURN_SHORTCUT)) return;
      outcomes.push(requestReturn());
    },
  };
  tui.addChild(component);
  tui.setFocus(component);

  // The seam patch 0007 adds: the parsed sequence's own provenance, for the sequence about to be delivered.
  // It consumes nothing and rewrites nothing, so every key still reaches the component unchanged.
  tui.addInputListener((data, provenance) => {
    seen.push({
      data: Buffer.from(data, "utf8").toString("latin1"),
      provenance: provenance === undefined || provenance === null
        ? null
        : {
            sequenceId: provenance.sequenceId ?? null,
            origin: provenance.origin ?? null,
            mixedOrigin: provenance.mixedOrigin ?? null,
            bindingGeneration: provenance.bindingGeneration ?? null,
            mixedBindingGeneration: provenance.mixedBindingGeneration ?? null,
          },
    });
    noteInputProvenance(provenance);
    return undefined;
  });

  // Backward compatibility for the widened type: a listener that declares one parameter must still work.
  const oneArgument = [];
  tui.addInputListener((data) => {
    oneArgument.push(Buffer.from(data, "utf8").toString("latin1"));
    return undefined;
  });

  tui.start();

  /** Run one case in isolation: nothing carried over, and the held provenance explicitly cleared first. */
  const runCase = async (name, body) => {
    asked.length = 0;
    outcomes.length = 0;
    seen.length = 0;
    clearInputProvenance();
    const dispatches = await body();
    return {
      case: name,
      dispatchResults: dispatches,
      provenanceSeen: [...seen],
      outcomes: [...outcomes],
      asked: [...asked],
    };
  };

  const cases = [];

  // Baseline: one attachment, one whole F9 in one span.
  cases.push(
    await runCase("single-origin-whole-f9", async () => [await span(terminal, "client-a", 1, F9)]),
  );

  // Same source, split across two spans. Native framing assembles it; it must remain usable.
  cases.push(
    await runCase("same-source-split-f9", async () => {
      const first = await span(terminal, "client-a", 1, "\u001b[20");
      const second = await span(terminal, "client-a", 1, "~");
      return [first, second];
    }),
  );

  // One span carrying an ordinary key AND an incomplete escape, completed by a later span from the same
  // attachment. The ordinary key is delivered first; the escape's suffix arrives afterwards.
  cases.push(
    await runCase("coalesced-key-plus-partial-escape", async () => {
      const first = await span(terminal, "client-a", 1, "x\u001b[2");
      const second = await span(terminal, "client-a", 1, "0~");
      return [first, second];
    }),
  );

  // Two attachments each supply part of one F9. The assembled sequence has no single origin.
  cases.push(
    await runCase("mixed-origin-split-f9", async () => {
      const first = await span(terminal, "client-a", 1, "\u001b[20");
      const second = await span(terminal, "client-b", 1, "~");
      return [first, second];
    }),
  );

  // The releaseTurn window: two dispatches outstanding at once. A sends an ordinary key, B sends the whole
  // gesture, and neither is awaited before the other is issued. B's F9 must detach B and never A.
  cases.push(
    await runCase("simultaneous-dispatches-b-presses-f9", async () => {
      const first = span(terminal, "client-a", 1, "x");
      const second = span(terminal, "client-b", 1, F9);
      return await Promise.all([first, second]);
    }),
  );

  // The same window with the roles reversed, so the result cannot be an artifact of dispatch order.
  cases.push(
    await runCase("simultaneous-dispatches-a-presses-f9", async () => {
      const first = span(terminal, "client-a", 1, F9);
      const second = span(terminal, "client-b", 1, "y");
      return await Promise.all([first, second]);
    }),
  );

  // Generation-bumping case LAST, deliberately. `dispatchNativeInput` refuses a span whose generation is below
  // the highest it has seen (`stale-binding`), so raising the generation here would make every later
  // generation-1 case refuse before it was ever framed. Ordering this last is what keeps the cases above real.
  cases.push(
    await runCase("mixed-generation-split-f9", async () => {
      const first = await span(terminal, "client-a", 1, "\u001b[20", 1);
      const second = await span(terminal, "client-a", 1, "~", 2);
      return [first, second];
    }),
  );

  tui.stop();
  terminal.stop();

  const record = {
    cohort: { consumerRoot: cohort.consumerRoot, manifest: cohort.manifestPath, buildSlurmJobId: cohort.buildSlurmJobId },
    shortcut: RETURN_SHORTCUT,
    listenerReceivesProvenance: cases.some((entry) => entry.provenanceSeen.some((entry_) => entry_.provenance !== null)),
    oneArgumentListenerCalls: oneArgument.length,
    cases,
  };
  process.stdout.write(`\u0001CASES\u0001${JSON.stringify(record)}\u0001END\u0001`);
}

await main();
