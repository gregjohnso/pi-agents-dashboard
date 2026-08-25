#!/usr/bin/env node

import { initializeRuntimePermissions } from "../runtime/permissions.mjs";

initializeRuntimePermissions();

const { runCli } = await import(new URL("../cli/main.mjs", import.meta.url).href);
process.exitCode = await runCli();
