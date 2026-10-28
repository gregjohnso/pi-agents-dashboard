#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runNativeCli } from "../cli/native-main.mjs";

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runNativeCli(argv, deps);
}

const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await main();
