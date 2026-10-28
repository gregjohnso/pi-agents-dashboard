#!/usr/bin/env node
/**
 * Run the attribution cases on a real terminal and assert what they found.
 *
 * `attribution-cases.mjs` drives the selected cohort's own `dispatchNativeInput` and reports, per case, the
 * provenance Pi delivered and what the gesture decided. This file is the judgement: it names the required
 * outcome for each case and fails loudly, with the case record attached, when one differs.
 *
 * The expectations are the parent's two adversarial hypotheses plus the cases that must keep working:
 *
 *   - a whole F9 from one attachment detaches that attachment;
 *   - an F9 split across two spans from the SAME attachment still detaches it — fragmentation is not a defect;
 *   - a span carrying an ordinary key and then an incomplete escape, completed by a later span from the same
 *     attachment, still detaches it;
 *   - an F9 whose bytes came from two different attachments detaches NOBODY;
 *   - an F9 assembled across two binding generations detaches NOBODY;
 *   - two dispatches outstanding at once attribute to whoever actually pressed the key, in both orders. This
 *     is the `releaseTurn()` window: the earlier FIFO scheme attributed B's F9 to A here.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openPtyProcess, stopIdentifiedProcess } from "./smoke.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "attribution-cases.mjs");

/** @type {{ case: string, detaches: { attachmentId: string, epoch: number } | null, reason?: RegExp }[]} */
const EXPECTATIONS = [
  { case: "single-origin-whole-f9", detaches: { attachmentId: "client-a", epoch: 1 } },
  { case: "same-source-split-f9", detaches: { attachmentId: "client-a", epoch: 1 } },
  { case: "coalesced-key-plus-partial-escape", detaches: { attachmentId: "client-a", epoch: 1 } },
  { case: "mixed-origin-split-f9", detaches: null, reason: /more than one attachment/u },
  { case: "mixed-generation-split-f9", detaches: null, reason: /two binding generations/u },
  { case: "simultaneous-dispatches-b-presses-f9", detaches: { attachmentId: "client-b", epoch: 1 } },
  { case: "simultaneous-dispatches-a-presses-f9", detaches: { attachmentId: "client-a", epoch: 1 } },
];

export async function runAttributionChecks({ evidenceDir }) {
  const spawned = [];
  const failures = [];
  let record;
  try {
    const fixture = await openPtyProcess({ args: [FIXTURE], label: "attribution-cases", spawned });
    await fixture.waitFor((_visible, raw) => raw.includes("\u0001END\u0001"), "the fixture's case record", 120_000);
    const exit = await fixture.waitForExit(30_000);
    const raw = fixture.raw();
    const start = raw.indexOf("\u0001CASES\u0001");
    const end = raw.indexOf("\u0001END\u0001");
    if (start === -1 || end === -1) throw new Error(`the fixture printed no case record; screen was ${JSON.stringify(fixture.visible().slice(-2000))}`);
    record = JSON.parse(raw.slice(start + "\u0001CASES\u0001".length, end));
    if (exit.code !== 0) throw new Error(`the fixture exited ${JSON.stringify(exit)}`);

    // Patch 0007 is the whole reason attribution is possible. If the listener saw no provenance, every case
    // below would refuse for the right-looking reason and prove nothing, so this is checked first.
    if (record.listenerReceivesProvenance !== true) {
      throw new Error(
        "the public input listener received no provenance, so the selected cohort does not carry patch 0007; " +
          `cohort was ${JSON.stringify(record.cohort)}`,
      );
    }
    // The widened type must not have broken a listener that declares one parameter.
    if (!(record.oneArgumentListenerCalls > 0)) {
      throw new Error(`a one-argument input listener was never called (${record.oneArgumentListenerCalls} calls)`);
    }

    const byName = new Map(record.cases.map((entry) => [entry.case, entry]));
    for (const expectation of EXPECTATIONS) {
      const found = byName.get(expectation.case);
      if (found === undefined) {
        failures.push(`${expectation.case}: the fixture ran no such case`);
        continue;
      }
      if (expectation.detaches === null) {
        if (found.asked.length !== 0) {
          failures.push(`${expectation.case}: expected to detach nobody, but asked for ${JSON.stringify(found.asked)}`);
          continue;
        }
        const refusals = found.outcomes.filter((outcome) => outcome.requested === false);
        if (refusals.length === 0) {
          failures.push(`${expectation.case}: expected a named refusal, got ${JSON.stringify(found.outcomes)}`);
          continue;
        }
        if (!refusals.some((outcome) => expectation.reason.test(outcome.reason))) {
          failures.push(`${expectation.case}: refused, but for the wrong reason: ${JSON.stringify(refusals.map((outcome) => outcome.reason))}`);
        }
        continue;
      }
      if (found.asked.length !== 1) {
        failures.push(
          `${expectation.case}: expected exactly one detach request for ${JSON.stringify(expectation.detaches)}, ` +
            `got ${JSON.stringify(found.asked)} with outcomes ${JSON.stringify(found.outcomes)} and provenance ${JSON.stringify(found.provenanceSeen)}`,
        );
        continue;
      }
      const [asked] = found.asked;
      if (asked.attachmentId !== expectation.detaches.attachmentId || asked.epoch !== expectation.detaches.epoch) {
        failures.push(`${expectation.case}: detached ${JSON.stringify(asked)}, expected ${JSON.stringify(expectation.detaches)}`);
      }
    }

    const result = { passed: failures.length === 0, failures, ...record };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "attribution-result.json"), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(path.join(evidenceDir, "attribution-fixture.visible.txt"), fixture.visible());
    if (failures.length > 0) throw new Error(`attribution checks failed:\n  ${failures.join("\n  ")}`);
    return result;
  } catch (error) {
    for (const process_ of spawned) {
      if (process_.handle.reapIfExited() !== null) continue;
      await stopIdentifiedProcess(process_.handle.owner, process_.label).catch(() => {});
    }
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.join(evidenceDir, "attribution-result.json"),
      `${JSON.stringify({ passed: false, failures, failure: /** @type {Error} */ (error).message, record: record ?? null }, null, 2)}\n`,
    );
    throw error;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--evidence");
  const evidenceDir = index === -1 ? path.join(tmpdir(), "attribution-evidence") : path.resolve(process.argv[index + 1]);
  const result = await runAttributionChecks({ evidenceDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
