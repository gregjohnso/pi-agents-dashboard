#!/usr/bin/env node

import { initializeRuntimePermissions } from "../runtime/permissions.mjs";
import { adoptRenamedStateRoot } from "../runtime/state-root-adoption.mjs";

initializeRuntimePermissions();

// Resolve the state root once, before anything else reads it, so the frontend, the daemon it
// starts, and the workers that daemon spawns all agree on exactly one root for this run.
async function main() {
  let adoption;
  try {
    adoption = await adoptRenamedStateRoot({ env: process.env });
  } catch (error) {
    process.stderr.write(`${/** @type {any} */ (error)?.code ?? "STATE_ROOT_UNUSABLE"}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (adoption.message !== undefined) process.stderr.write(`${adoption.message}\n`);
  process.env.PI_AGENTS_STATE_DIR = adoption.root;

  const { runCli } = await import(new URL("../cli/main.mjs", import.meta.url).href);
  return runCli();
}

process.exitCode = await main();
